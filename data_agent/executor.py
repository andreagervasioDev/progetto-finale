"""
Interprete Python "deterministico" usato dal pandas agent.

L'LLM scrive codice, questo modulo lo esegue davvero su un namespace persistente
(che contiene il DataFrame) e restituisce l'output reale. Prima dell'esecuzione il
codice viene analizzato con l'AST per bloccare le operazioni pericolose
(accesso al filesystem, rete, processi, import non autorizzati).
"""

from __future__ import annotations

import ast
import contextlib
import io
import traceback

ALLOWED_IMPORTS = {"pandas", "numpy", "matplotlib", "matplotlib.pyplot", "seaborn", "math",
                   "statistics", "datetime", "scipy", "scipy.stats", "collections", "itertools"}
FORBIDDEN_NAMES = {"open", "exec", "eval", "compile", "__import__", "input", "globals", "locals",
                   "vars", "getattr", "setattr", "delattr", "breakpoint", "exit", "quit"}
FORBIDDEN_ATTRS = {"to_csv", "to_excel", "to_pickle", "to_parquet", "to_sql", "read_csv", "read_pickle",
                   "system", "popen", "remove", "rmdir", "unlink"}
MAX_OUTPUT_CHARS = 6000


class UnsafeCodeError(Exception):
    pass


def check_code(code: str) -> None:
    tree = ast.parse(code)
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.name not in ALLOWED_IMPORTS:
                    raise UnsafeCodeError(f"Import non consentito: {alias.name}")
        elif isinstance(node, ast.ImportFrom):
            if (node.module or "") not in ALLOWED_IMPORTS:
                raise UnsafeCodeError(f"Import non consentito: {node.module}")
        elif isinstance(node, ast.Name) and node.id in FORBIDDEN_NAMES:
            raise UnsafeCodeError(f"Funzione non consentita: {node.id}")
        elif isinstance(node, ast.Attribute):
            if node.attr.startswith("__") or node.attr in FORBIDDEN_ATTRS:
                raise UnsafeCodeError(f"Attributo non consentito: {node.attr}")


class PythonExecutor:
    """REPL con stato: le variabili create in un passo restano disponibili nei successivi."""

    def __init__(self, namespace: dict):
        self.namespace = namespace

    def run(self, code: str) -> str:
        try:
            check_code(code)
        except SyntaxError as e:
            return f"SyntaxError: {e}"
        except UnsafeCodeError as e:
            return f"Codice rifiutato per sicurezza: {e}"

        stdout = io.StringIO()
        try:
            tree = ast.parse(code)
            # come in un notebook: se l'ultima istruzione e' un'espressione, ne stampo il valore
            last_expr = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last_expr = ast.Expression(tree.body.pop().value)
            with contextlib.redirect_stdout(stdout):
                exec(compile(tree, "<agent>", "exec"), self.namespace)
                if last_expr is not None:
                    value = eval(compile(last_expr, "<agent>", "eval"), self.namespace)
                    if value is not None:
                        print(repr(value) if not hasattr(value, "to_string") else value.to_string())
        except Exception:
            tb = traceback.format_exc(limit=2)
            return (stdout.getvalue() + "\n" + tb)[-MAX_OUTPUT_CHARS:]

        out = stdout.getvalue().strip() or "(eseguito, nessun output: usa print() per vedere i risultati)"
        if len(out) > MAX_OUTPUT_CHARS:
            out = out[:MAX_OUTPUT_CHARS] + "\n... [output troncato]"
        return out
