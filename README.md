# Management AI

**Piattaforma con agente AI ibrido e multi-tool per la gestione di un club di calcio**

Una piattaforma web per lo staff di un club di Serie A, organizzata in quattro aree (**Home**, **Documenti**, **Assistente AI**, **Dati**), con un assistente AI disponibile in ogni pagina tramite un pannello laterale. Ogni utente può:

- gestire un **archivio per categorie** (contratti giocatori, sponsorizzazioni, area medica, mercato, analisi prestazioni, regolamenti, dati): al caricamento l'AI **propone la categoria** e il titolo, e per contratti, sponsor, certificati e offerte **estrae i dati chiave** (persona, controparte, importo, scadenza), che finiscono nel riquadro **"Prossime scadenze"** della Home;
- **caricare documenti** (PDF, Word, TXT, Markdown), leggerli dentro l'app e farci domande. I file vengono indicizzati automaticamente in ChromaDB;
- **caricare file Excel e CSV** che vengono puliti e diventano **analizzabili dal data agent** con grafici, come il dataset delle partite;
- fare domande su **regolamenti, protocolli medici, linee guida, FAQ e documenti caricati**: l'agente risponde tramite una **RAG su ChromaDB** che cita le fonti, con un link al documento e alla pagina;
- chiedere **analisi numeriche sui dati delle partite**: l'agente delega a un **pandas agent Python** che pulisce il dataset, scrive ed esegue codice, genera grafici e ne restituisce una sintesi;
- porre **domande ibride**, per esempio *"Abbiamo rispettato l'obiettivo di incidenza infortuni previsto dal protocollo?"*. In questo caso l'agente recupera prima la regola dalla knowledge base e poi la applica ai dati.

L'agente sceglie da solo quale strumento usare (paradigma **ReAct**, Reason + Act, tramite function calling OpenAI). Per ogni risposta l'interfaccia mostra i passi eseguiti: strumenti chiamati, fonti recuperate, codice Python generato e operazioni di pulizia dei dati.

---

## Indice

1. [Scenario aziendale](#1-scenario-aziendale)
2. [Architettura](#2-architettura)
3. [Struttura del progetto](#3-struttura-del-progetto)
4. [Prerequisiti](#4-prerequisiti)
5. [Installazione](#5-installazione)
6. [Configurazione (.env)](#6-configurazione-env)
7. [Avvio](#7-avvio)
8. [Domande di esempio](#8-domande-di-esempio)
9. [Dati e knowledge base](#9-dati-e-knowledge-base)
10. [Dettagli tecnici](#10-dettagli-tecnici)
11. [API](#11-api)
12. [Sicurezza](#12-sicurezza)
13. [Risoluzione dei problemi](#13-risoluzione-dei-problemi)

---

## 1. Scenario aziendale

Il caso aziendale è un club di Serie A **fittizio**, costruito su un caso realistico, che usa la piattaforma **Management AI**. Il reparto considerato è l'**Area Performance & Medical**: preparatori atletici, staff medico, match analyst e allenatore.

| Esigenza | Problema oggi | Soluzione |
|---|---|---|
| **Informazioni testuali** | Regole su sanzioni, convocazioni, return-to-play, soglie di carico e procedure sono sparse in manuali PDF che nessuno ha tempo di consultare | RAG su 4 documenti interni con citazione delle fonti |
| **Insight dai dati** | Le statistiche per partita (GPS, xG, wellness, infortuni) sono in un CSV "sporco" esportato da più sistemi, e ogni analisi richiede un match analyst | Pandas agent che pulisce i dati, analizza, genera grafici e spiega i risultati |

Le due fonti sono **complementari**. La knowledge base definisce le soglie (ACWR > 1,5, wellness < 5, minimo 450 minuti per i ranking per 90', obiettivo di meno di 20 infortuni ogni 1.000 ore), il dataset contiene i numeri a cui applicarle.

---

## 2. Architettura

```
┌──────────────────────────┐  POST /api/chat/stream (SSE)  ┌─────────────────────────────────────┐
│  frontend/  React + Vite │ ────────────────────────────▶ │  backend/  Node.js + Express         │
│  · chat + cronologia     │ ◀──── eventi di stato ─────── │  · conversazioni salvate su disco    │
│  · indicatore di stato   │ ◀──── risposta finale ─────── │  · orchestratore ReAct (OpenAI       │
│  · markdown + grafici    │                               │    function calling)                 │
│  · passi e fonti         │   GET /api/charts/:file       │  · RAG custom (chunking, embedding,  │
└──────────────────────────┘ ────────────────────────────▶ │    retrieval)                        │
       :5173                                               └──────┬──────────────────────┬────────┘
                                                                  │ tool:                │ tool:
                                                                  │ search_knowledge_base│ analyze_data
                                                                  ▼                      ▼ HTTP POST /analyze
                                                  ┌───────────────────────┐  ┌──────────────────────────────────┐
                                                  │ ChromaDB (locale)     │  │ data_agent/  Python + FastAPI      │
                                                  │ collection            │  │ · pipeline di data cleaning        │
                                                  │management_ai_documents│  │ · pandas agent ReAct (OpenAI)      │
                                                  │ embedding OpenAI      │  │ · interprete Python sandboxed      │
                                                  └───────────────────────┘  │ · grafici matplotlib/seaborn → PNG │
                                                          :8000              └──────────────────────────────────┘
                                                                                           :8001
```

### Come l'agente decide

1. Il frontend invia il messaggio e l'id della conversazione (`sessionId`). Il backend recupera la cronologia salvata su disco.
2. L'**orchestratore** manda all'LLM il system prompt, la cronologia, il messaggio e la descrizione dei 2 strumenti.
3. L'LLM **ragiona** e sceglie:
   - nessuno strumento: saluti o domande sulle capacità dell'assistente;
   - `search_knowledge_base`: contenuto dei documenti (regole, clausole, importi, scadenze), eventualmente limitato a una **categoria**;
   - `analyze_data`: numeri, classifiche, trend, grafici su uno dei **dataset** (partite o file Excel/CSV caricati, scelto con `dataset_id`);
   - **entrambi in sequenza**: prima recupera la soglia dalla KB, poi la passa al data agent nel campo `context`.
4. Il backend **esegue** gli strumenti (anche più d'uno in parallelo) e restituisce i risultati all'LLM (**observe**). Il ciclo continua finché il modello non produce la risposta finale, con un massimo di `MAX_AGENT_STEPS` passi.
5. Durante l'esecuzione il backend invia eventi SSE ("Consulto la knowledge base", "Il data agent analizza il dataset"...), che il frontend mostra nell'indicatore di digitazione.

Il data agent Python è a sua volta un agente ReAct: scrive codice pandas, lo esegue davvero, legge l'output o l'eventuale errore, corregge e itera fino alla sintesi finale.

---

## 3. Struttura del progetto

```
Progetto finale/
├── .env.example                 # template delle variabili d'ambiente (copiare in .env)
├── .gitignore                   # esclude .env, node_modules, .venv, chroma_data, grafici
├── package.json                 # script di comodo: setup e avvio di tutti i servizi
├── README.md
│
├── frontend/                    # React 19 + Vite
│   ├── index.html
│   ├── vite.config.js           # proxy /api → backend
│   ├── public/                  # logo, icona, favicon a pallone
│   └── src/
│       ├── App.jsx              # verifica sessione, rotte, struttura (menu · pagina · pannello AI)
│       ├── api.js               # client REST/SSE (profilo, chat, documenti con upload, dati)
│       ├── context/ChatContext.jsx # stato chat condiviso tra pagina Assistente e pannello laterale
│       ├── pages/
│       │   ├── HomePage.jsx           # benvenuto, numeri rapidi, recenti, domande di esempio
│       │   ├── DocumentsPage.jsx      # elenco club/personali, ricerca, drag & drop
│       │   ├── DocumentViewerPage.jsx # lettore PDF/Word/Markdown/TXT + "Chiedi all'AI"
│       │   ├── AssistantPage.jsx      # chat a tutta pagina con cronologia
│       │   └── DataPage.jsx           # scelta del dataset + panoramica (KPI, pulizia, anteprima)
│       ├── components/
│       │   ├── NavBar.jsx          # menu principale e profilo
│       │   ├── ChatView.jsx        # conversazione (usata a tutta pagina e nel pannello)
│       │   ├── ChatDrawer.jsx      # assistente nel pannello laterale destro
│       │   ├── AiFab.jsx           # pulsante flottante "Chiedi all'AI"
│       │   ├── UploadDialog.jsx    # caricamento: categoria proposta dall'AI, titolo, avanzamento
│       │   ├── DatasetView.jsx     # panoramica di un dataset (pagina Dati e lettore Excel/CSV)
│       │   ├── ChatMessage.jsx     # rendering markdown (tabelle GFM) + grafici
│       │   ├── ChartGallery.jsx    # immagini dei grafici con zoom e download
│       │   ├── ToolTrace.jsx       # "Come ho risposto": strumenti, fonti cliccabili, codice, cleaning
│       │   ├── TypingIndicator.jsx # indicatore con lo stato live dell'agente
│       │   ├── BallLoader.jsx      # caricamento con pallone che rimbalza
│       │   └── Composer.jsx, EmptyState.jsx, Icon.jsx, TypeBadge.jsx
│       ├── suggestions.js, format.js
│       └── styles.css
│
├── backend/                     # Node.js 20+ / Express 5
│   ├── knowledge_base/          # documenti ufficiali importati all'avvio; sottocartelle = categorie
│   │   ├── *.md                 # regolamenti e procedure (radice)
│   │   └── contratti/ sponsor/ medico/ mercato/ prestazioni/ dati/
│   │   ├── 01_regolamento_interno_prima_squadra.md
│   │   ├── 02_protocollo_medico_infortuni_rtp.md
│   │   ├── 03_linee_guida_carico_e_kpi.md
│   │   └── 04_faq_staff_e_procedure.md
│   └── src/
│       ├── server.js            # endpoint REST/SSE, health check, proxy dei grafici
│       ├── config.js            # lettura del .env
│       ├── openaiClient.js
│       ├── conversationStore.js # conversazioni persistenti per utente (storage/conversations/<userId>/)
│       ├── auth/userStore.js    # profilo unico della piattaforma (storage/users.json), niente login
│       ├── agent/orchestrator.js# ciclo ReAct con function calling
│       ├── tools/index.js       # i 2 tool: ricerca (con categoria/documento aperto) e analisi (con dataset)
│       ├── documents/
│       │   ├── routes.js        # API documenti e dataset: upload, proposta categoria, scadenze, modifica
│       │   ├── categories.js    # categorie dell'archivio (con estrazione dati chiave e cartella)
│       │   ├── ai.js            # AI sui documenti: proposta categoria/titolo, estrazione dati chiave
│       │   ├── dataAgentClient.js # registrazione dei file Excel/CSV nel data agent
│       │   ├── documentStore.js # metadati (storage/documents.json) e file (storage/files/)
│       │   ├── extract.js       # estrazione testo: PDF per pagina (pdf-parse), Word (mammoth), MD/TXT
│       │   └── indexer.js       # elaborazione per documento + sincronizzazione all'avvio
│       └── rag/
│           ├── chunker.js       # chunking per sezioni markdown / per pagina, con overlap
│           ├── vectorStore.js   # client Chroma + embedding OpenAI + retrieval filtrato per permessi
│           └── ingest.js        # sincronizzazione/re-indicizzazione da riga di comando
│
└── data_agent/                  # Python 3.10+ / FastAPI
    ├── app.py                   # microservizio: /analyze, /datasets, /charts, /health
    ├── datasets.py              # archivio dataset: lettura CSV/Excel, pulizia generica, schema per l'LLM
    ├── agent.py                 # pandas agent ReAct (OpenAI tool calling)
    ├── executor.py              # interprete Python con controlli di sicurezza (AST)
    ├── cleaning.py              # pipeline di data cleaning dedicata al dataset partite
    ├── datasets/                # file Excel/CSV caricati dagli utenti (escluso da git)
    ├── requirements.txt
    ├── charts/                  # PNG generati a runtime
    └── data/
        ├── generate_dataset.py  # generatore riproducibile del CSV (seed fisso)
        └── player_performance.csv
```

---

## 4. Prerequisiti

| Software | Versione | Verifica |
|---|---|---|
| Node.js | **20 o superiore** (testato con 22) | `node -v` |
| npm | 10 o superiore | `npm -v` |
| Python | **3.10 o superiore** (testato con 3.13) | `python3 --version` |
| Chiave API OpenAI | con accesso a chat completions ed embeddings | [platform.openai.com](https://platform.openai.com/api-keys) |

ChromaDB **non** richiede installazioni separate: il server locale è incluso nel pacchetto npm `chromadb` (comando `chroma run`).

---

## 5. Installazione

### Opzione A: tutto con un comando (macOS / Linux)

Dalla root del progetto:

```bash
npm run setup
```

Il comando installa le dipendenze della root, del backend e del frontend, crea il virtualenv Python in `data_agent/.venv` e ci installa i requisiti.

### Opzione B: un ambiente alla volta

```bash
# 1) Backend Node.js (include il server ChromaDB)
cd backend
npm install
cd ..

# 2) Frontend React
cd frontend
npm install
cd ..

# 3) Data agent Python
cd data_agent
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
deactivate
cd ..

# 4) (facoltativo) strumenti della root per l'avvio con un solo comando
npm install
```

> Il CSV è già incluso. Per rigenerarlo in modo identico (seed fisso):
> `cd data_agent && .venv/bin/python data/generate_dataset.py`

---

## 6. Configurazione (.env)

C'è **un solo file `.env` nella root**, letto sia dal backend Node sia dal data agent Python.

```bash
cp .env.example .env
```

Poi apri `.env` e inserisci la tua chiave:

```ini
OPENAI_API_KEY=sk-...la-tua-chiave...
```

| Variabile | Default | Descrizione |
|---|---|---|
| `OPENAI_API_KEY` | — | **Obbligatoria** |
| `OPENAI_MODEL` | `gpt-4.1-mini` | Modello per l'orchestratore e il pandas agent |
| `DATA_AGENT_MODEL` | = `OPENAI_MODEL` | Modello diverso solo per il data agent (facoltativo) |
| `OPENAI_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding per la RAG |
| `STORAGE_DIR` | `storage` | Cartella (dentro `backend/`) con profilo, documenti e conversazioni |
| `KNOWLEDGE_BASE_DIR` | `knowledge_base` | Cartella (dentro `backend/`) dei documenti ufficiali importati all'avvio |
| `DATASETS_DIR` | `datasets` | Cartella (dentro `data_agent/`) dei file Excel/CSV registrati nel data agent |
| `BACKEND_PORT` | `3002` | Porta del backend |
| `CHROMA_PORT` | `8000` | Porta di ChromaDB |
| `DATA_AGENT_PORT` / `DATA_AGENT_URL` | `8001` / `http://127.0.0.1:8001` | Microservizio Python |
| `MAX_AGENT_STEPS` | `6` | Passi ReAct massimi dell'orchestratore |
| `DATA_AGENT_MAX_STEPS` | `8` | Passi ReAct massimi del pandas agent |
| `MAX_HISTORY_MESSAGES` | `20` | Messaggi di cronologia inviati all'LLM |

Il file `.env` è escluso da git tramite `.gitignore`. **Non va mai committato.**

---

## 7. Avvio

L'architettura è composta da **4 processi**. L'ordine consigliato è quello indicato qui sotto.

### Opzione A: un solo comando (macOS / Linux)

```bash
npm run dev
```

Il comando avvia in parallelo, con log colorati, ChromaDB, il data agent, il backend e il frontend. Il backend attende che Chroma sia pronto. Apri **http://localhost:5173**.

### Opzione B: 4 terminali (tutti i sistemi operativi)

**Terminale 1: ChromaDB** (database vettoriale locale, dati persistiti in `backend/chroma_data/`)
```bash
cd backend
npm run chroma
```

**Terminale 2: data agent Python** (FastAPI su :8001)
```bash
cd data_agent
source .venv/bin/activate          # Windows: .venv\Scripts\activate
python app.py
```

**Terminale 3: backend Node** (Express su :3002)
```bash
cd backend
npm run dev
```
Al primo avvio il backend importa i documenti ufficiali e li **indicizza automaticamente** in ChromaDB:
```
Backend Management AI in ascolto su http://localhost:3002 (modello: gpt-4.1-mini)
  + documento ufficiale aggiunto: Regolamento Interno Prima Squadra – Management AI
  ...
  - indicizzato: Regolamento Interno Prima Squadra – Management AI (9 chunk)
  ...
Knowledge base pronta: 4 documenti, 37 chunk (4 documenti indicizzati ora)
```

**Terminale 4: frontend React** (Vite su :5173)
```bash
cd frontend
npm run dev
```

Apri **http://localhost:5173**.

### Primo accesso

Non c'è login: all'apertura si entra direttamente nella Home. La piattaforma usa un **profilo unico** ("Staff del club", creato al primo avvio in `backend/storage/users.json`, dove si possono modificare nome e ruolo), con un'unica cronologia e un unico archivio documenti.

### Come si usa

| Area | Cosa fai |
|---|---|
| **Home** | Riepilogo: documenti, dataset, scadenze entro 90 giorni e conversazioni; **prossime scadenze** (contratti, certificati, sponsor, offerte) con i giorni rimanenti; documenti e chat recenti; domande di esempio |
| **Documenti** | Archivio con la **colonna delle categorie**. Carichi un file con il pulsante o trascinandolo: l'AI legge l'inizio e **propone categoria e titolo**, che puoi cambiare. Excel e CSV finiscono sempre in "Dati". Cerchi anche per persona o controparte, leggi, scarichi o elimini (i documenti ufficiali no) |
| **Lettore** | Mostra la **scheda dei dati chiave** estratti dall'AI e permette di cambiare categoria. Premi **Chiedi all'AI**: le domande sono limitate a quel file (o, per un Excel/CSV, l'analisi usa quei dati). Puoi passare alle domande generali con un clic |
| **Assistente AI** | La chat a tutta pagina con la cronologia. Dal pannello laterale il pulsante ⤢ porta qui la stessa conversazione |
| **Dati** | Scegli il dataset (partite o file caricati) e vedi numeri, passi di pulizia automatica, valori mancanti, anteprima delle righe pulite o grezze e schema delle colonne |

### Verifica

- Controlla lo stato di tutti i servizi con: `curl http://localhost:3002/api/health`
  ```json
  {"backend":"ok","chroma":"ok","knowledgeBaseChunks":37,"dataAgent":"ok","datasetRows":1539,"openaiKeyConfigured":true}
  ```
- Documentazione interattiva del data agent: http://localhost:8001/docs

### Indicizzazione dei documenti

- I documenti caricati dall'interfaccia vengono indicizzati **subito**, al momento del caricamento.
- All'avvio il backend **sincronizza** ChromaDB con l'archivio: importa i documenti ufficiali di `backend/knowledge_base/`, indicizza ciò che manca e rimuove i chunk di documenti eliminati.
- **Documenti ufficiali**: per aggiungere un documento che deve far parte del progetto (e quindi arrivare anche a chi scarica il repository), copia il file in `backend/knowledge_base/` (formati **PDF, Word .docx, Markdown, TXT, Excel, CSV**) e riavvia il backend. La **sottocartella decide la categoria**: `contratti/`, `sponsor/`, `medico/`, `mercato/`, `prestazioni/`, `dati/`; i file nella radice sono "Regolamenti e procedure". I file Excel/CSV vengono registrati nel data agent. Il titolo è il primo `# Titolo` per il Markdown e il nome del file per gli altri formati (`05_policy_trasferte.pdf` diventa "Policy trasferte"). Se modifichi un file viene aggiornato al riavvio successivo; se lo togli dalla cartella sparisce anche dall'app.
- I documenti caricati dal browser invece sono salvati in `backend/storage/files/` (con i metadati in `storage/documents.json`) e indicizzati in `backend/chroma_data/`. Entrambe le cartelle sono escluse da git, perché sono dati locali dell'utente.
- Per re-indicizzare tutto da zero, per esempio dopo aver cambiato modello di embedding, ferma il backend e lancia:
  ```bash
  cd backend
  npm run ingest:reset
  ```

---

## 8. Domande di esempio

| Tipo | Domanda | Strumenti attesi |
|---|---|---|
| RAG | Quali sono le fasi del return-to-play dopo un infortunio muscolare? | RAG |
| RAG | Che multa rischia un giocatore che arriva in ritardo di 20 minuti? | RAG |
| RAG | Cosa prevede il protocollo in caso di commozione cerebrale? | RAG |
| Dati | Chi sono i 10 migliori marcatori? Confronta gol ed xG con un grafico. | Data agent |
| Dati | Come è cambiata la distanza media per 90' per ruolo tra le due stagioni? | Data agent |
| Dati | Quali tipi di infortunio sono più frequenti e quanti giorni di stop causano? | Data agent |
| Dati | Che problemi di qualità aveva il dataset grezzo? | Data agent (usa `df_raw`) |
| Ibrida | Abbiamo rispettato l'obiettivo di incidenza infortuni nella stagione 2025-26? | RAG + data agent |
| Ibrida | Quali giocatori hanno un wellness medio sotto la soglia di allerta? | RAG + data agent |
| Ibrida | Chi ha la differenza gol − xG più significativa secondo le linee guida? | RAG + data agent |
| Memoria | *(dopo una domanda sui dati)* "E solo per i difensori?" | Data agent con contesto ricostruito |
| Documento aperto | *(dal lettore di un PDF caricato)* "Fammi un riassunto di questo documento" | RAG limitato al file |
| Scadenze | Quali contratti o certificati medici scadono nei prossimi sei mesi? | Dati chiave + RAG (categorie contratti e medico) |
| Categoria | Che bonus prevede lo sponsor tecnico in caso di qualificazione europea? | RAG (categoria sponsor) |
| File di dati | *(da un Excel caricato con gli ingaggi)* "Qual è l'ingaggio medio per ruolo? Fammi un grafico" | Data agent sul file caricato |

---

## 9. Dati e knowledge base

### Dataset: `data_agent/data/player_performance.csv`

- **1.578 righe × 40 colonne**. Ogni riga corrisponde a un giocatore in una partita.
- 102 partite di 2 stagioni (2024-25 e 2025-26) tra Serie A, Europa League e Coppa Italia; rosa di 26 giocatori.
- Colonne: dati partita (data, competizione, avversario, casa/trasferta, risultato), giocatore (ruolo, età, titolare), prestazione (minuti, gol, assist, tiri, xG, xA, passaggi, duelli, rating), **GPS** (distanza, HSR, sprint, top speed), **carico e benessere** (RPE, wellness), cartellini e **infortuni** (tipo, giorni di stop).
- I dati sono sintetici ma coerenti: gli infortuni dipendono dal carico (ACWR), dal wellness, dall'età e dalla propensione individuale; i gol sono correlati a xG e qualità del giocatore. Per questo le analisi producono insight credibili.

**Anomalie introdotte volutamente** (vedi `generate_dataset.py`):

| Anomalia | Esempio | Gestione in `cleaning.py` |
|---|---|---|
| Righe duplicate | doppio export GPS (30 righe) | rimosse |
| Valori mancanti | GPS non registrato, xG, wellness, rating | imputazione con la mediana del giocatore (riscalata sui minuti per le metriche GPS); **rating non imputato** |
| Date in 3 formati | `2025-03-12`, `12/03/2025`, `12 Mar 2025` | parsing multiformato |
| Nomi incoerenti | `  VICTOR OKAFOR `, `victor okafor` | trim, maiuscole e nome canonico per `player_id` |
| Ruoli e competizioni con alias | `DIF`, `Difensore`, `DF`, `dif` / `UEL`, `serie a` | mappatura su valori standard |
| Numeri come testo | `"87%"`, `"0,45"` | conversione numerica |
| Scala errata | pass accuracy `0.87`, distanza `10450` (metri) | riscalati |
| Fuori range | minuti `-15` / `999`, top speed `350`, rating `15`, wellness `45` | invalidati (NaN) o scartati |

Risultato: **1.578 righe grezze → 1.539 righe pulite**. Il report completo compare nell'interfaccia sotto *"Come ho risposto" → Data cleaning*.

### Knowledge base

La knowledge base è composta dai **documenti ufficiali del club** (i file di `backend/knowledge_base/`, importati all'avvio come documenti non eliminabili dall'interfaccia) e da **tutti i documenti caricati** dall'interfaccia, organizzati in categorie:

| Categoria | Contenuto tipico | Dati chiave estratti dall'AI |
|---|---|---|
| Contratti giocatori | contratti, rinnovi, clausole, prestiti | sì |
| Sponsorizzazioni | accordi con sponsor e fornitori | sì |
| Area medica | certificati, idoneità, referti | sì |
| Mercato | offerte, trattative | sì |
| Analisi prestazioni | report di match analysis e scouting | no |
| Regolamenti e procedure | regolamenti, protocolli, linee guida, FAQ | no |
| Dati (Excel / CSV) | tabelle da analizzare con il data agent | — |
| Altri documenti | tutto il resto | no |

| Documento ufficiale | Contenuto |
|---|---|
| Regolamento Interno Prima Squadra | orari, tabella delle multe, convocazioni e turnover (max 270' in 8 giorni), ritiri, privacy e GDPR sui dati GPS, social, premi |
| Protocollo Medico – Infortuni e RTP | definizione e gravità degli infortuni, procedura 2h/24h/48h, semaforo verde/giallo/rosso, return-to-play in 6 fasi, tempi di recupero, commozione cerebrale, prevenzione, KPI di incidenza |
| Linee guida carico e KPI | glossario delle colonne del dataset, soglie ACWR, wellness e RPE, valori di riferimento per ruolo, **regole per le analisi** (per 90', minimo 450', esclusione dei portieri), obiettivi stagionali, interpretazione di gol ed xG |
| FAQ Staff e procedure | organizzazione dell'area, settimana tipo, recupero e nutrizione, integratori, questionario wellness, trasferte, settore giovanile |

---

## 10. Dettagli tecnici

### RAG custom (backend)
- **Estrazione del testo**: PDF pagina per pagina con `pdf-parse`, così le fonti citano la pagina; Word con `mammoth`; Markdown e TXT così come sono. I PDF scansionati, senza testo, vengono rifiutati con un messaggio chiaro.
- **Chunking per struttura**: il Markdown è diviso per titoli `##` e `###`, PDF e Word per pagina e paragrafo; i paragrafi troppo lunghi vengono spezzati per frasi (max ~1.400 caratteri, overlap di 200). Titolo del documento e sezione o pagina sono inclusi nel testo embeddato, per migliorare il retrieval.
- **Metadati**: ogni chunk porta `docId`, titolo, **categoria**, sezione o pagina, visibilità e proprietario. La ricerca può filtrare per categoria (parametro `category` del tool, scelto dall'LLM; se il filtro non trova nulla si ripete su tutto l'archivio) e, con un documento aperto, per `docId`.
- **Proposta di categoria e dati chiave**: al caricamento l'LLM (risposta in JSON) propone categoria e titolo leggendo l'inizio del testo; per contratti, sponsorizzazioni, area medica e mercato estrae persona, controparte, importo e data di scadenza. Le date in formato ISO alimentano l'endpoint delle scadenze e vengono passate all'orchestratore nel system prompt. Il filtro sui permessi (`visibility`/`ownerId`) è già presente nel codice, così si può reintrodurre facilmente una gestione multi-utente.
- **Embedding**: funzione di embedding custom per Chroma basata su OpenAI `text-embedding-3-small`, usata sia in indicizzazione sia in query.
- **Indice**: collection Chroma con distanza **coseno**. L'ingest è idempotente (`upsert` con id deterministici).
- **Retrieval**: top-4 chunk (5 dentro un singolo documento) con similarità, documento e sezione o pagina. Sono passati all'LLM con le etichette di fonte e mostrati nel frontend come link che aprono il documento alla pagina giusta.

### Orchestratore (backend)
- Function calling nativo dell'**SDK OpenAI**, senza framework, così il ciclo ReAct è esplicito e leggibile in `agent/orchestrator.js`.
- Supporta **chiamate parallele** e **catene di strumenti** (KB → data agent con `context`).
- **Contesto per richiesta**: il system prompt include l'utente, l'archivio raggruppato per categoria, i **dati chiave** (scadenze e importi), i **dataset disponibili** con le loro colonne e l'eventuale documento o dataset aperto. Con un documento aperto il tool di ricerca espone il parametro `scope` (`documento_aperto` / `tutti`); con un dataset aperto l'analisi usa quel `dataset_id`.
- **Memoria e cronologia**: ogni conversazione è salvata in `backend/storage/conversations/<userId>/<id>.json` con testo, grafici, fonti e passi dell'agente, scritta in modo atomico. Sopravvive al riavvio dei servizi. Dalla sidebar "Cronologia" (raggruppata per Oggi, Ieri, Ultimi 7 giorni) si può riaprire una chat passata e continuarla: all'LLM vengono ripassati gli ultimi `MAX_HISTORY_MESSAGES` messaggi. Il browser ricorda solo quale conversazione era aperta.
- Ogni risposta include la `trace`, cioè i passi, gli argomenti, la durata, le fonti, il codice e il report di pulizia. Il flusso è quindi **verificabile**.

### Pandas agent (data_agent)
- Agente ReAct con un solo strumento, `run_python`: l'LLM scrive codice, `executor.py` lo **esegue davvero** in un namespace persistente e l'output reale torna al modello. I numeri della risposta vengono quindi da calcoli effettivi e non da stime dell'LLM (interprete deterministico).
- **Più dataset**: il dataset partite usa la **pipeline di cleaning dedicata** (`cleaning.py`); i file Excel/CSV caricati passano da una **pulizia generica** tracciata (`datasets.py`): nomi di colonna, righe e colonne vuote, duplicati, spazi, numeri salvati come testo in formato italiano (`€ 1.234,50`, `15%`), date. Lo **schema** di ogni file (tipi, range, esempi di valori) viene generato in automatico e passato all'LLM. Excel: primo foglio non vuoto; CSV: separatore e codifica rilevati automaticamente.
- L'agente riceve `df` (pulito), `df_raw` (grezzo) e `cleaning_report`, e può applicare **pulizie aggiuntive specifiche per la domanda** (per le partite: escludere rating NaN, soglia minima di minuti, esclusione dei portieri).
- **Grafici**: l'helper `save_chart(title)` salva la figura matplotlib/seaborn in `charts/` con palette e stile del club. Il backend espone i PNG tramite proxy (`/api/charts/:file`) e il frontend li mostra con zoom e download.
- **Perché non `create_pandas_dataframe_agent` di LangChain?** Un agente custom con l'SDK OpenAI dà pieno controllo su sicurezza (validazione AST), gestione dei grafici, formato della risposta e tracciamento dei passi. Inoltre evita le frequenti incompatibilità di versione di `langchain-experimental`. Il paradigma resta lo stesso: ReAct con uno strumento Python REPL.

### Frontend
- React 19 + Vite, `react-markdown` + `remark-gfm` per tabelle ed elenchi.
- Streaming **SSE** per lo stato live ("Analizzo la richiesta" → "Consulto la knowledge base" → "Il data agent analizza il dataset"), con i passi completati mostrati nell'indicatore di digitazione.
- **React Router** per le quattro aree. Lo stato della chat è in un **context condiviso**: pannello laterale e pagina Assistente mostrano la stessa conversazione, e il pulsante ⤢ cambia solo la vista.
- Caricamento con **barra di avanzamento** (XMLHttpRequest) e **drag & drop**; lettore integrato per PDF (visualizzatore del browser, con salto alla pagina citata), Word (HTML), Markdown e TXT.
- Tema "stadio": menu verde campo con le linee del terreno di gioco, pagine bianche, accento arancione. Layout responsive (menu a scomparsa e pannello AI a schermo intero su mobile).

---

## 11. API

### Backend (`http://localhost:3002`)

| Metodo | Endpoint | Descrizione |
|---|---|---|
| `POST` | `/api/chat` | `{ message, sessionId?, docId? }` → `{ sessionId, title, message, reply, charts[], sources[], trace[] }` |
| `POST` | `/api/chat/stream` | Stesso body; risposta `text/event-stream` con eventi `session`, `status`, `tool_result`, `final`, `error` |
| `GET` | `/api/conversations` | Elenco delle conversazioni salvate (id, titolo, date, n. messaggi) |
| `GET` | `/api/conversations/:id` | Conversazione completa, per riaprirla |
| `PATCH` | `/api/conversations/:id` | Rinomina: `{ title }` |
| `DELETE` | `/api/conversations/:id` | Elimina una conversazione |
| `GET` | `/api/charts/:file` | Proxy verso i PNG del data agent |
| `GET` | `/api/documents` | Elenco dei documenti (ufficiali e caricati) |
| `GET` | `/api/documents/categories` | Categorie dell'archivio |
| `GET` | `/api/documents/deadlines` | Documenti con una scadenza estratta dall'AI, ordinati per giorni rimanenti |
| `POST` | `/api/documents/suggest` | `multipart`: `file` → `{ category, title }` proposti dall'AI |
| `POST` | `/api/documents` | Upload `multipart/form-data`: `file` (PDF/DOCX/TXT/MD/CSV/XLSX, max 20 MB), `category`, `title?` → indicizzazione + dati chiave, oppure registrazione nel data agent |
| `GET` | `/api/documents/:id` | Metadati del documento (categoria, dati chiave, righe per i dataset) |
| `PATCH` | `/api/documents/:id` | `{ title?, category? }` → rielabora indice e dati chiave (solo documenti caricati) |
| `GET` | `/api/documents/:id/content` | Contenuto per il lettore (`format`: `pdf`, `html`, `markdown`, `text`, `dataset`) |
| `GET` | `/api/documents/:id/file` | File originale (inline; `?download=1` per scaricarlo) |
| `DELETE` | `/api/documents/:id` | Elimina file e chunk (gli ufficiali no) |
| `GET` | `/api/datasets` | Dataset analizzabili (partite + file Excel/CSV dell'archivio) |
| `GET` | `/api/datasets/:id/overview` | Schema, pulizia, valori mancanti e anteprima righe di un dataset |
| `GET` | `/api/health` | Stato di backend, Chroma, data agent e chiave OpenAI (pubblico) |
| `GET` | `/api/me` | Profilo della piattaforma (nome e ruolo) |

Esempio:
```bash
curl -X POST http://localhost:3002/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Quali sono le soglie ACWR?","sessionId":"demo-conversazione-1"}'
```

### Data agent (`http://localhost:8001`, documentazione su `/docs`)

| Metodo | Endpoint | Descrizione |
|---|---|---|
| `POST` | `/analyze` | `{ question, context?, dataset_id? }` → `{ answer, charts[], steps[], dataset, cleaning_report, elapsed_s }` |
| `GET` | `/datasets` | Dataset disponibili (id, titolo, righe, colonne) |
| `POST` | `/datasets` | `multipart`: `id`, `title`, `file` (CSV/XLSX/XLS) → lettura, pulizia, registrazione persistente |
| `DELETE` | `/datasets/{id}` | Rimuove un dataset caricato (non quello delle partite) |
| `GET` | `/datasets/{id}/overview?rows=N` | Schema, riepilogo, report di pulizia, valori mancanti, anteprima righe pulite e grezze |
| `GET` | `/charts/{file}` | PNG generati |
| `GET` | `/health` | Stato del servizio |

---

## 12. Sicurezza

- **Nessuna chiave nel codice**: tutte le credenziali sono lette da `.env` (`dotenv` / `python-dotenv`), che è escluso dal version control. Nel repository c'è solo `.env.example` con dei segnaposto.
- **Nessun login**: la piattaforma è pensata per l'uso locale da parte dello staff, con un profilo unico. Per esporla in rete andrebbe aggiunta un'autenticazione davanti al backend (es. SSO aziendale o reverse proxy con login).
- `backend/storage/` (profilo, documenti e chat) è escluso dal version control.
- **Esecuzione di codice generato dall'LLM**: prima di eseguirlo, `executor.py` analizza il codice con l'AST e blocca gli import non consentiti (sono permessi solo pandas, numpy, matplotlib, seaborn, math, statistics, datetime, scipy, collections e itertools), le funzioni pericolose (`open`, `exec`, `eval`, `__import__`, `getattr`...), gli attributi dunder e i metodi di scrittura o lettura su file (`to_csv`, `read_csv`...). L'output è troncato.
  *Limite noto*: non è una sandbox a livello di sistema operativo. In produzione il data agent andrebbe eseguito in un container isolato, senza rete e con limiti di CPU e memoria.
- **Upload**: solo estensioni consentite (PDF, DOCX, TXT, MD), massimo 20 MB, file salvati con nome casuale (id) fuori dalla cartella pubblica. Se l'indicizzazione fallisce, il caricamento viene annullato senza lasciare documenti a metà. Nell'HTML ricavato dai file Word vengono neutralizzati i link `javascript:`; il Markdown è mostrato senza HTML grezzo.
- Il data agent ascolta solo su `127.0.0.1`. Il backend valida l'input (lunghezza massima) e i nomi dei file dei grafici (regex, niente path traversal) e limita CORS all'origine del frontend.
- **Dati sensibili** (certificati medici, contratti, offerte di mercato): i file restano sul computer che esegue la piattaforma, ma i pezzi di testo vengono inviati a OpenAI per gli embedding, per l'estrazione dei dati chiave e, quando pertinenti, per le risposte. Senza login, inoltre, chiunque apra l'app vede tutto l'archivio. Per un uso reale servirebbero autenticazione con permessi per categoria (il filtro `ownerId`/`visibility` è già presente nei metadati), un accordo sul trattamento dei dati con il provider o un modello eseguito in locale.

---

## 13. Risoluzione dei problemi

| Problema | Soluzione |
|---|---|
| `OPENAI_API_KEY mancante` | Crea `.env` nella **root** del progetto (non in `backend/`) partendo da `.env.example`, poi riavvia backend e data agent |
| `/api/health` → `"chroma": "offline"` | Avvia `npm run chroma` in `backend/`; controlla che la porta 8000 sia libera |
| `/api/health` → `"dataAgent": "offline"` | Avvia `python app.py` in `data_agent/` con il virtualenv attivo |
| `EADDRINUSE` / porta occupata | Cambia `BACKEND_PORT` nel `.env`; se cambi la porta del backend avvia il frontend con `VITE_BACKEND_URL=http://localhost:<porta> npm run dev` |
| Knowledge base vuota o da aggiornare | `cd backend && npm run ingest:reset` |
| Pagina Dati: "Dati non disponibili" | Il data agent non è avviato o è una versione vecchia: riavvialo (`python app.py` in `data_agent/`) |
| Caricamento PDF: "Non sono riuscito a estrarre testo" | Il PDF è una scansione (immagine): serve prima un OCR |
| Excel/CSV: "Impossibile leggere il file" | Controlla che il file abbia una riga di intestazione e dati nel primo foglio; per i CSV sono accettati virgola, punto e virgola e tabulazione |
| La pagina Dati non mostra i file caricati | Il data agent va riavviato dopo l'aggiornamento (le dipendenze `openpyxl` e `python-multipart` sono in `requirements.txt`) |
| Errore 401 dal modello | Chiave OpenAI non valida o senza credito |
| Modello non disponibile | Imposta nel `.env` un modello disponibile per il tuo account, per esempio `OPENAI_MODEL=gpt-4o-mini` |
| Risposte lente sulle analisi | Normale: il pandas agent può eseguire 2-5 cicli di codice. Il timeout è configurabile con `DATA_AGENT_TIMEOUT_MS` |
| Windows: `npm run dev` / `setup` dalla root non funzionano | Usa l'**Opzione B** (4 terminali) e `.venv\Scripts\activate` |
