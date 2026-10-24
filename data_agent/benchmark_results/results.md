# Benchmark del data agent

Eseguito il 2026-10-24T16:01:51 · Python 3.13.9 · pandas 3.0.6 · macOS-26.3.1-arm64-arm-64bit-Mach-O · DuckDB 2.0.0

## Tempo (secondi, mediana)

| Operazione | 1.578 righe | 10.000 righe | 50.000 righe | 100.000 righe | 250.000 righe |
|---|---:|---:|---:|---:|---:|
| Caricamento CSV | 0.003 | 0.017 | 0.071 | 0.138 | 0.338 |
| Pulizia | 0.071 | 0.346 | 1.655 | 3.306 | 8.257 |
| Classifica marcatori | 0.001 | 0.002 | 0.006 | 0.014 | 0.031 |
| Distanza per 90' per ruolo | 0.001 | 0.003 | 0.012 | 0.024 | 0.060 |
| Wellness sotto soglia | 0.001 | 0.002 | 0.006 | 0.012 | 0.030 |
| Incidenza infortuni | 0.000 | 0.001 | 0.002 | 0.004 | 0.010 |
| ACWR (carico acuto/cronico) | 0.004 | 0.007 | 0.020 | 0.042 | 0.105 |
| Classifica marcatori (DuckDB) | 0.002 | 0.002 | 0.003 | 0.004 | 0.007 |
| Distanza per 90' per ruolo (DuckDB) | 0.002 | 0.002 | 0.003 | 0.004 | 0.008 |
| Wellness sotto soglia (DuckDB) | 0.002 | 0.002 | 0.002 | 0.004 | 0.006 |
| Incidenza infortuni (DuckDB) | 0.001 | 0.001 | 0.002 | 0.003 | 0.005 |
| ACWR (carico acuto/cronico) (DuckDB) | 0.003 | 0.003 | 0.008 | 0.013 | 0.022 |

## Memoria (MB)

| Misura | 1.578 righe | 10.000 righe | 50.000 righe | 100.000 righe | 250.000 righe |
|---|---:|---:|---:|---:|---:|
| File CSV | 0.3 | 1.6 | 8.1 | 16.1 | 40.5 |
| DataFrame grezzo | 1.4 | 8.7 | 43.4 | 86.9 | 217.4 |
| DataFrame pulito | 1.2 | 7.3 | 36.7 | 73.4 | 183.5 |
| **Picco all'avvio** (grezzo + pulizia) | **3.7** | **22.3** | **110.8** | **221.6** | **553.8** |
| Picco: Caricamento CSV | 0.8 | 3.8 | 18.7 | 37.4 | 93.4 |
| Picco: Pulizia | 2.3 | 13.6 | 67.4 | 134.7 | 336.4 |
| Picco: Classifica marcatori | 0.3 | 1.7 | 8.4 | 16.7 | 43.2 |
| Picco: Distanza per 90' per ruolo | 0.6 | 3.5 | 17.1 | 34.2 | 88.5 |
| Picco: Wellness sotto soglia | 0.3 | 1.7 | 8.4 | 16.7 | 43.2 |
| Picco: Incidenza infortuni | 0.1 | 0.4 | 1.8 | 3.5 | 11.8 |
| Picco: ACWR (carico acuto/cronico) | 1.6 | 9.5 | 47.4 | 94.8 | 236.8 |

## Quando cambiare strumento

- **Tempo**: fino a 250.000 righe tutte le analisi restano sotto 1 s: pandas basta.
- **Memoria**: a 250.000 righe il picco all'avvio (553.8 MB) supera i 256 MB disponibili per i dati sul piano gratuito di Render (512 MB in tutto, condivisi con Python, backend Node e ChromaDB).
- **Pulizia**: è l'operazione più costosa perché converte i valori uno per uno (date e numeri in più formati). Si esegue una sola volta all'avvio, quindi pesa sul tempo di avvio, non sulle risposte.

Regola pratica: quando una delle due soglie viene superata, conviene salvare i dati puliti in DuckDB (o in Parquet letto da DuckDB) e far scrivere all'agente query SQL, invece di tenere tutto in un DataFrame pandas. SQLite ha senso se servono scritture frequenti e concorrenti; per analisi in sola lettura DuckDB è più veloce.
