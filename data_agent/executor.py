"""
Interprete Python "deterministico" usato dal pandas agent, con difesa in profondità.

L'LLM scrive codice, questo modulo lo esegue davvero su un namespace persistente
(che contiene il DataFrame) e restituisce l'output reale. Il codice generato da un
LLM NON è fidato (prompt injection: istruzioni nascoste dentro i documenti o i file
caricati possono spingere il modello a generare codice ostile), quindi più barriere
indipendenti lo contengono:

  1. Analisi AST: blocca import non consentiti, nomi e attributi pericolosi, e gli
     accessi "dunder" (__class__, __globals__, __subclasses__, __builtins__, ...),
     la via classica per evadere una sandbox Python.
  2. Builtins ridotti: il codice gira con un __builtins__ privo di open, __import__,
     eval, exec, getattr, ... Anche se un controllo AST venisse aggirato, quelle
     funzioni non esistono nel namespace dell'esecuzione.
  3. Funzioni di I/O neutralizzate: i metodi pandas/numpy che leggono o scrivono file
     o rete (read_csv, to_csv, read_json via URL, np.load, ...) sono sostituiti da
     versioni che sollevano un errore, così il codice non può leggere il .env o altri
     file del server né esfiltrare dati sulla rete.
  4. Timeout: il codice gira in un thread sorvegliato; se supera il tempo massimo,
     l'esecuzione viene abbandonata e il passo riporta l'errore (evita che un ciclo
     molto lungo blocchi la risposta).

NB: non è una sandbox a livello di sistema operativo. Resta fuori portata il limite
di memoria rigido e l'interruzione forzata di un ciclo infinito "puro" (senza I/O):
Python non può terminare un thread dall'esterno. In produzione il data agent va
comunque eseguito in un container isolato, senza rete e senza segreti nell'ambiente,
con limiti di CPU e memoria imposti dal sistema. Qui l'obiettivo raggiunto è impedire
che il codice generato legga file fuori dal dataset, usi la rete o scriva su disco.
"""

from __future__ import annotations

import ast
import builtins
import ctypes
import io
import os
import threading

# Import consentiti nel codice generato: solo librerie di analisi e visualizzazione.
ALLOWED_IMPORTS = {"pandas", "numpy", "matplotlib", "matplotlib.pyplot", "seaborn", "math",
                   "statistics", "datetime", "scipy", "scipy.stats", "collections", "itertools"}

# Nomi (built-in o variabili) che non devono comparire nel codice.
FORBIDDEN_NAMES = {"open", "exec", "eval", "compile", "__import__", "input", "globals", "locals",
                   "vars", "getattr", "setattr", "delattr", "hasattr", "breakpoint", "exit", "quit",
                   "memoryview", "help", "__builtins__", "__loader__", "__spec__"}

# Metodi/attributi vietati: scrittura e lettura di file/DB da pandas/numpy, accesso al sistema.
FORBIDDEN_ATTRS = {
    # scrittura su disco / DB
    "to_csv", "to_excel", "to_pickle", "to_parquet", "to_sql", "to_hdf", "to_feather",
    "to_json", "to_stata", "to_orc", "to_xml", "to_latex", "to_markdown", "to_clipboard",
    "save", "savez", "savez_compressed", "savetxt", "tofile", "dump", "memmap",
    # lettura da disco / rete / DB
    "read_csv", "read_excel", "read_pickle", "read_parquet", "read_sql", "read_sql_query",
    "read_sql_table", "read_json", "read_html", "read_hdf", "read_feather", "read_stata",
    "read_orc", "read_xml", "read_table", "read_fwf", "read_clipboard", "read_gbq",
    "read_spss", "read_sas", "fromfile", "load", "loadtxt", "genfromtxt",
    # sistema / processi / salvataggio immagini (i grafici si salvano solo via save_chart)
    "system", "popen", "remove", "rmdir", "unlink", "makedirs", "mkdir", "chmod", "chown",
    "savefig", "imsave",
}

MAX_OUTPUT_CHARS = 6000
TIMEOUT_SECONDS = int(os.getenv("DATA_AGENT_EXEC_TIMEOUT", "15"))


class UnsafeCodeError(Exception):
    pass


def check_code(code: str) -> None:
    """Analisi statica (AST): rifiuta il codice pericoloso prima di eseguirlo."""
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
            raise UnsafeCodeError(f"Nome non consentito: {node.id}")
        elif isinstance(node, ast.Attribute):
            # blocca sia i metodi vietati sia gli attributi "dunder" (__class__, __globals__,
            # __subclasses__, __builtins__...), la via classica per evadere una sandbox Python
            if node.attr.startswith("__") or node.attr in FORBIDDEN_ATTRS:
                raise UnsafeCodeError(f"Attributo non consentito: {node.attr}")
        elif isinstance(node, ast.Subscript):
            # blocca builtins['open'], __builtins__["__import__"], ecc.
            target = node.value
            name = getattr(target, "id", None) or getattr(target, "attr", None)
            if name in {"__builtins__", "builtins"}:
                raise UnsafeCodeError("Accesso ai builtins non consentito.")


# Built-in "sicuri" esposti al codice generato: niente open, __import__, eval, getattr...
_SAFE_BUILTIN_NAMES = (
    "abs", "all", "any", "bin", "bool", "bytes", "chr", "complex", "dict", "divmod",
    "enumerate", "filter", "float", "format", "frozenset", "hex", "int", "isinstance",
    "issubclass", "len", "list", "map", "max", "min", "next", "oct", "ord", "pow", "print",
    "range", "repr", "reversed", "round", "set", "slice", "sorted", "str", "sum", "tuple",
    "type", "zip",
    # eccezioni di uso comune nell'analisi
    "Exception", "ValueError", "TypeError", "KeyError", "IndexError", "AttributeError",
    "ZeroDivisionError", "StopIteration", "RuntimeError", "ArithmeticError",
)


def _safe_builtins() -> dict:
    safe = {name: getattr(builtins, name) for name in _SAFE_BUILTIN_NAMES if hasattr(builtins, name)}
    safe["True"], safe["False"], safe["None"] = True, False, None
    return safe


def _blocked(*_a, **_k):
    raise UnsafeCodeError("Operazione su file o rete non consentita nell'analisi dei dati.")


class _ModuleProxy:
    """Vista di sola lettura su un modulo (pandas/numpy) con le funzioni vietate disattivate.

    Non modifica il modulo reale: gli attributi vietati (read_csv, to_csv, np.load, ...)
    restituiscono una funzione che solleva un errore; tutto il resto è delegato al modulo
    originale. Così il codice generato non legge/scrive file del server, ma il resto del
    data agent continua a usare pandas/numpy normalmente.
    """

    def __init__(self, module):
        object.__setattr__(self, "_module", module)

    def __getattr__(self, name):
        if name in FORBIDDEN_ATTRS:
            return _blocked
        return getattr(object.__getattribute__(self, "_module"), name)

    def __setattr__(self, name, value):
        raise UnsafeCodeError("Non è consentito modificare pandas/numpy.")


def harden_namespace(namespace: dict) -> dict:
    """Prepara il namespace: builtins ridotti e pandas/numpy sostituiti dai loro proxy sicuri."""
    ns = dict(namespace)
    ns["__builtins__"] = _safe_builtins()
    for mod_key in ("pd", "np"):
        if ns.get(mod_key) is not None:
            ns[mod_key] = _ModuleProxy(ns[mod_key])
    return ns


def _async_raise(thread_id: int, exc_type) -> None:
    """Solleva un'eccezione in un thread in esecuzione (per interromperlo allo scadere del tempo)."""
    ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(thread_id), ctypes.py_object(exc_type))


class _Timeout(Exception):
    pass


class PythonExecutor:
    """REPL con stato: le variabili create in un passo restano disponibili nei successivi.

    Il codice viene prima validato (AST), poi eseguito con built-in ridotti e I/O
    neutralizzato, sotto un timeout. Lo stato (DataFrame e variabili intermedie) resta
    nel namespace tra un passo e l'altro, come in un notebook.
    """

    def __init__(self, namespace: dict):
        # i moduli pd/np vengono "induriti" una volta sola, all'avvio dell'analisi
        self.namespace = harden_namespace(namespace)

    def _execute(self, code: str, stdout: io.StringIO, result: dict) -> None:
        try:
            tree = ast.parse(code)
            # come in un notebook: se l'ultima istruzione e' un'espressione, ne stampo il valore
            last_expr = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last_expr = ast.Expression(tree.body.pop().value)
            import contextlib
            with contextlib.redirect_stdout(stdout):
                exec(compile(tree, "<agent>", "exec"), self.namespace)
                if last_expr is not None:
                    value = eval(compile(last_expr, "<agent>", "eval"), self.namespace)
                    if value is not None:
                        print(repr(value) if not hasattr(value, "to_string") else value.to_string())
        except _Timeout:
            result["text"] = f"Codice interrotto: superato il limite di tempo ({TIMEOUT_SECONDS}s). Evita cicli molto lunghi."
        except Exception:
            import traceback
            result["text"] = (stdout.getvalue() + "\n" + traceback.format_exc(limit=2))[-MAX_OUTPUT_CHARS:]

    def run(self, code: str) -> str:
        try:
            check_code(code)
        except SyntaxError as e:
            return f"SyntaxError: {e}"
        except UnsafeCodeError as e:
            return f"Codice rifiutato per sicurezza: {e}"

        stdout = io.StringIO()
        result: dict = {}
        worker = threading.Thread(target=self._execute, args=(code, stdout, result), daemon=True)
        worker.start()
        worker.join(TIMEOUT_SECONDS)
        if worker.is_alive():
            # tempo scaduto: provo a interrompere il thread sollevando _Timeout al suo interno
            _async_raise(worker.ident, _Timeout)
            worker.join(2)
            if "text" not in result:
                result["text"] = f"Codice interrotto: superato il limite di tempo ({TIMEOUT_SECONDS}s). Evita cicli molto lunghi."

        if "text" in result:
            return result["text"]
        out = stdout.getvalue().strip() or "(eseguito, nessun output: usa print() per vedere i risultati)"
        if len(out) > MAX_OUTPUT_CHARS:
            out = out[:MAX_OUTPUT_CHARS] + "\n... [output troncato]"
        return out
