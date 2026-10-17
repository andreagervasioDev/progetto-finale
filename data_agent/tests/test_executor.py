"""Interprete Python del pandas agent: esegue codice di analisi, blocca le operazioni pericolose."""

import numpy as np
import pandas as pd
import pytest

from executor import PythonExecutor, UnsafeCodeError, check_code


@pytest.fixture
def executor():
    df = pd.DataFrame({"player": ["A", "B", "C"], "goals": [3, 5, 1]})
    return PythonExecutor({"df": df, "pd": pd, "np": np})


def test_esegue_codice_pandas_e_restituisce_l_output(executor):
    assert executor.run("print(df['goals'].sum())") == "9"


def test_l_ultima_espressione_viene_stampata_come_in_un_notebook(executor):
    out = executor.run("df.sort_values('goals', ascending=False).iloc[0]['player']")
    assert out == "'B'"


def test_le_variabili_restano_tra_un_passo_e_l_altro(executor):
    executor.run("top = df[df['goals'] > 2]")
    assert executor.run("print(len(top))") == "2"


def test_gli_errori_tornano_come_testo_invece_di_interrompere_l_agente(executor):
    out = executor.run("df['colonna_inesistente']")
    assert "KeyError" in out
    assert executor.run("print(").startswith("SyntaxError")


@pytest.mark.parametrize(
    "code",
    [
        # import non consentiti
        "import os",
        "import subprocess",
        "from pathlib import Path",
        # funzioni pericolose
        "open('/etc/passwd').read()",
        "__import__('os').system('ls')",
        "eval('1+1')",
        "getattr(df, 'to_csv')('x.csv')",
        # lettura di file del server (esfiltrazione: legge il .env, /etc/passwd, ...)
        "pd.read_csv('/etc/hosts')",
        "pd.read_table('../.env')",
        "pd.read_json('http://attaccante.example/x.json')",
        "np.load('/etc/hosts')",
        "np.loadtxt('../.env')",
        # scrittura su disco
        "df.to_csv('/tmp/rubati.csv')",
        "df.to_json('/tmp/rubati.json')",
        # evasione via attributi dunder
        "().__class__.__bases__",
        "().__class__.__bases__[0].__subclasses__()",
        "df.__class__.__init__.__globals__",
        # accesso diretto ai builtins
        "__builtins__['open']('/etc/passwd')",
    ],
)
def test_codice_pericoloso_rifiutato(executor, code):
    with pytest.raises(UnsafeCodeError):
        check_code(code)
    assert executor.run(code).startswith("Codice rifiutato per sicurezza")


def test_alias_di_funzione_vietata_non_esegue(executor):
    """Anche assegnando la funzione a una variabile (r = pd.read_csv), l'I/O resta bloccato."""
    out = executor.run("r = pd.read_csv\nr('../.env')")
    assert out.startswith("Codice rifiutato per sicurezza")


def test_savefig_bloccato_ma_save_chart_consentito():
    """I grafici si salvano solo con save_chart(); plt.savefig diretto è vietato (scrive dove vuole)."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    charts = []
    ex = PythonExecutor({"pd": pd, "np": np, "plt": plt, "save_chart": lambda t="g": charts.append(t)})
    assert ex.run("plt.plot([1, 2]); plt.savefig('/tmp/x.png')").startswith("Codice rifiutato per sicurezza")
    ex.run("plt.plot([1, 2, 3]); save_chart('ok')")
    assert charts == ["ok"]


def test_il_timeout_interrompe_un_ciclo_troppo_lungo(monkeypatch):
    """Un ciclo che non termina non blocca il server: scatta il timeout (ridotto per il test)."""
    import executor as ex_mod

    monkeypatch.setattr(ex_mod, "TIMEOUT_SECONDS", 2)
    ex = PythonExecutor({"pd": pd, "np": np})
    out = ex.run("x = 0\nwhile True:\n    x += 1")
    assert "limite di tempo" in out


def test_pandas_globale_non_viene_modificato():
    """L'indurimento del namespace non deve rompere pandas per il resto del data agent."""
    PythonExecutor({"pd": pd, "np": np})
    assert pd.read_csv.__name__ == "read_csv"
    assert np.load.__name__ == "load"


def test_import_consentiti():
    check_code("import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt\nimport seaborn as sns")
