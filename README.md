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
2. [Requisiti della traccia](#2-requisiti-della-traccia)
3. [Architettura](#3-architettura)
4. [Struttura del progetto](#4-struttura-del-progetto)
5. [Prerequisiti](#5-prerequisiti)
6. [Installazione](#6-installazione)
7. [Configurazione (.env)](#7-configurazione-env)
8. [Avvio](#8-avvio)
9. [Test](#9-test)
10. [Domande di esempio](#10-domande-di-esempio)
11. [Dati e knowledge base](#11-dati-e-knowledge-base)
12. [Dettagli tecnici](#12-dettagli-tecnici)
13. [Scelte di design](#13-scelte-di-design)
14. [API](#14-api)
15. [Sicurezza](#15-sicurezza)
16. [Limiti noti](#16-limiti-noti)
17. [Risoluzione dei problemi](#17-risoluzione-dei-problemi)

---

## 1. Scenario aziendale

Il caso aziendale è un club di Serie A **fittizio**, costruito su un caso realistico, che usa la piattaforma **Management AI**. Il reparto considerato è l'**Area Performance & Medical**: preparatori atletici, staff medico, match analyst e allenatore.

| Esigenza | Problema oggi | Soluzione |
|---|---|---|
| **Informazioni testuali** | Regole su sanzioni, convocazioni, return-to-play, soglie di carico e procedure sono sparse in manuali PDF che nessuno ha tempo di consultare | RAG su 4 documenti interni con citazione delle fonti |
| **Insight dai dati** | Le statistiche per partita (GPS, xG, wellness, infortuni) sono in un CSV "sporco" esportato da più sistemi, e ogni analisi richiede un match analyst | Pandas agent che pulisce i dati, analizza, genera grafici e spiega i risultati |

Le due fonti sono **complementari**. La knowledge base definisce le soglie (ACWR > 1,5, wellness < 5, minimo 450 minuti per i ranking per 90', obiettivo di meno di 20 infortuni ogni 1.000 ore), il dataset contiene i numeri a cui applicarle.

---

## 2. Requisiti della traccia

Corrispondenza tra i requisiti del progetto e la loro implementazione.

| Requisito | Dove si trova |
|---|---|
| CSV di almeno 1000 righe con metriche, categorie, date e numeri | `data_agent/data/player_performance.csv`: 1.578 righe × 40 colonne ([sezione 11](#11-dati-e-knowledge-base)) |
| Anomalie: valori mancanti, duplicati, formati incoerenti, fuori range | 8 tipi di anomalia introdotti da `generate_dataset.py`, verificati da `data_agent/tests/test_cleaning.py` |
| Documento di testo/PDF come knowledge base | 4 documenti in `backend/knowledge_base/` (regolamento, protocollo medico, linee guida, FAQ); in più PDF, Word, TXT e MD caricabili dall'interfaccia |
| Frontend React con chat come punto di interazione | `frontend/`: pagina Assistente e pannello laterale presente in ogni pagina |
| Memoria conversazionale e stato asincrono dei messaggi | conversazioni salvate su disco e riprendibili (`repositories/conversationRepository.js`, `context/ChatContext.jsx`) |
| Stato di caricamento ("sta ragionando" / "sta eseguendo codice") | eventi SSE dal backend mostrati da `TypingIndicator.jsx` |
| Rendering di testo e grafici generati dal backend | `ChatMessage.jsx` (Markdown + tabelle), `ChartGallery.jsx` (PNG dal data agent) |
| Endpoint `POST /api/chat`, session state e function calling | `backend/src/routes/chat.routes.js` → `services/chatService.js` → `services/agentService.js` |
| L'LLM decide in autonomia tra RAG e data agent (ReAct) | SDK OpenAI nativo, tool `search_knowledge_base` e `analyze_data` (`tools/index.js`) |
| RAG con istanza locale di ChromaDB: avvio, indicizzazione, retrieval | `npm run chroma`, indicizzazione automatica all'avvio (`services/documentService.js`, `rag/`) |
| Integrazione Node ↔ Python tramite microservizio locale | FastAPI su `:8001`, chiamato da `clients/dataAgentClient.js` |
| Agente pandas: domanda → codice Python → pulizia → grafico su disco → sintesi | `data_agent/agent.py`, `executor.py`, `cleaning.py`; grafici in `data_agent/charts/` |
| Interprete deterministico di codice | `executor.py`: il codice viene eseguito davvero, in una sandbox a più barriere (AST, builtins ridotti, I/O neutralizzato, timeout), verificata da `test_executor.py` |
| API key solo in `.env`, escluso dal version control | `.env` nella root, `.env.example` con segnaposto, `.gitignore` |
| README con installazione dei 3 ambienti e sequenza di avvio | sezioni [6](#6-installazione) e [8](#8-avvio) |

Oltre ai requisiti, la piattaforma aggiunge l'accesso con password e una dashboard di amministrazione (spesa in token, utenti, storico delle attività), un archivio documenti per categorie con caricamento da web, l'estrazione di scadenze e importi e l'analisi di file Excel/CSV caricati dall'utente (vedi [Scelte di design](#13-scelte-di-design)).

---

## 3. Architettura

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

## 4. Struttura del progetto

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
│       │   ├── LoginPage.jsx          # accesso con nome utente e password
│       │   ├── AdminPage.jsx          # amministrazione: spesa AI, utenti, attività, conversazioni
│       │   ├── AssistantPage.jsx      # chat a tutta pagina con cronologia
│       │   └── DataPage.jsx           # scelta del dataset + panoramica (KPI, pulizia, anteprima)
│       ├── components/
│       │   ├── NavBar.jsx          # menu principale e profilo
│       │   ├── ChatView.jsx        # conversazione (usata a tutta pagina e nel pannello)
│       │   ├── ChatDrawer.jsx      # assistente nel pannello laterale destro
│       │   ├── AiFab.jsx           # pulsante flottante "Chiedi all'AI"
│       │   ├── UploadDialog.jsx    # caricamento: trascinamento o scelta del file, categoria proposta dall'AI
│       │   ├── FileDropUpload.jsx  # trascinamento di file da Finder / Esplora risorse in qualsiasi pagina
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
│   ├── tests/                   # test Node (node:test): chunking, categorie, scadenze, prompt, API HTTP
│   └── src/                     # architettura a livelli
│       ├── server.js            # avvio: porta + sincronizzazione della knowledge base
│       ├── app.js               # app Express: middleware e montaggio delle rotte (importabile dai test)
│       ├── config.js            # lettura del .env
│       ├── routes/              # endpoint HTTP: validano l'input e chiamano i servizi
│       │   ├── chat.routes.js         # POST /api/chat e /api/chat/stream (SSE)
│       │   ├── conversations.routes.js
│       │   ├── documents.routes.js    # upload, proposta categoria, scadenze, modifica, lettore
│       │   ├── datasets.routes.js
│       │   ├── charts.routes.js       # proxy dei grafici del data agent
│       │   ├── auth.routes.js         # login e logout
│       │   ├── admin.routes.js        # dashboard admin: KPI di spesa, utenti, attività, conversazioni
│       │   ├── activity.routes.js     # registrazione delle ricerche
│       │   ├── health.routes.js
│       │   └── profile.routes.js
│       ├── services/            # logica applicativa
│       │   ├── chatService.js         # turno di chat: contesto, cronologia, agente, salvataggio
│       │   ├── agentService.js        # ciclo ReAct con function calling
│       │   ├── documentService.js     # elaborazione dei documenti + sincronizzazione all'avvio
│       │   ├── documentAiService.js   # AI sui documenti: proposta categoria/titolo, dati chiave
│       │   ├── authService.js         # login, sessioni firmate (cookie HttpOnly), blocco dei tentativi
│       │   ├── passwordService.js     # hash delle password con scrypt
│       │   ├── usageService.js        # token consumati, prezzi e spesa stimata
│       │   ├── activityService.js     # storico di accessi, domande, ricerche e caricamenti
│       │   ├── requestContext.js      # utente della richiesta in corso (per attribuire token e attività)
│       │   ├── datasetService.js      # dataset analizzabili (partite + file caricati)
│       │   └── deadlineService.js     # calcolo delle scadenze
│       ├── prompts/systemPrompt.js    # system prompt dell'orchestratore
│       ├── tools/index.js       # i 2 tool: ricerca (con categoria/documento aperto) e analisi (con dataset)
│       ├── rag/
│       │   ├── chunker.js       # chunking per sezioni markdown / per pagina, con overlap
│       │   ├── vectorStore.js   # client Chroma + embedding OpenAI + retrieval filtrato
│       │   └── ingest.js        # sincronizzazione/re-indicizzazione da riga di comando
│       ├── repositories/        # dati salvati su disco (backend/storage/)
│       │   ├── conversationRepository.js # conversazioni per utente, scrittura atomica
│       │   ├── documentRepository.js     # metadati (documents.json) e file (files/)
│       │   ├── userRepository.js         # utenti con password (hash scrypt) e ruolo admin (users.json)
│       │   └── eventLogRepository.js     # registri attività e consumo token (activity.jsonl, usage.jsonl)
│       ├── clients/             # servizi esterni
│       │   ├── openaiClient.js
│       │   └── dataAgentClient.js  # tutte le chiamate HTTP verso il data agent Python
│       ├── middleware/auth.js   # sessione obbligatoria sulle API, area admin riservata
│       └── documents/
│           ├── categories.js    # categorie dell'archivio (con estrazione dati chiave e cartella)
│           └── extract.js       # estrazione testo: PDF per pagina (pdf-parse), Word (mammoth), MD/TXT
│
└── data_agent/                  # Python 3.10+ / FastAPI
    ├── app.py                   # microservizio: /analyze, /datasets, /charts, /health
    ├── datasets.py              # archivio dataset: lettura CSV/Excel, pulizia generica, schema per l'LLM
    ├── agent.py                 # pandas agent ReAct (OpenAI tool calling)
    ├── executor.py              # sandbox: AST + builtins ridotti + I/O neutralizzato + timeout
    ├── cleaning.py              # pipeline di data cleaning dedicata al dataset partite
    ├── datasets/                # file Excel/CSV caricati dagli utenti (escluso da git)
    ├── tests/                   # test pytest: pulizia, interprete, dataset, API
    ├── requirements.txt
    ├── requirements-dev.txt     # requirements.txt + pytest e httpx per i test
    ├── charts/                  # PNG generati a runtime
    └── data/
        ├── generate_dataset.py  # generatore riproducibile del CSV (seed fisso)
        └── player_performance.csv
```

---

## 5. Prerequisiti

| Software | Versione | Verifica |
|---|---|---|
| Node.js | **20 o superiore** (testato con 22) | `node -v` |
| npm | 10 o superiore | `npm -v` |
| Python | **3.10 o superiore** (testato con 3.13) | `python3 --version` |
| Chiave API OpenAI | con accesso a chat completions ed embeddings | [platform.openai.com](https://platform.openai.com/api-keys) |

ChromaDB **non** richiede installazioni separate: il server locale è incluso nel pacchetto npm `chromadb` (comando `chroma run`).

---

## 6. Installazione

### Opzione A: tutto con un comando (macOS / Linux)

Dalla root del progetto:

```bash
npm run setup
```

Il comando installa le dipendenze della root, del backend e del frontend, crea il virtualenv Python in `data_agent/.venv` e ci installa i requisiti (comprese le dipendenze dei test).

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
pip install -r requirements-dev.txt   # facoltativo: solo per eseguire i test
deactivate
cd ..

# 4) (facoltativo) strumenti della root per l'avvio con un solo comando
npm install
```

> Il CSV è già incluso. Per rigenerarlo in modo identico (seed fisso):
> `cd data_agent && .venv/bin/python data/generate_dataset.py`

---

## 7. Configurazione (.env)

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
| `DEFAULT_ADMIN_PASSWORD` / `DEFAULT_TEST_PASSWORD` | `admin` / `test` | Password degli utenti creati al primo avvio |
| `AUTH_SECRET` | generata | Chiave che firma le sessioni; se manca viene creata in `backend/storage/.auth_secret` |
| `SESSION_DAYS` | `7` | Durata della sessione dopo il login |

Il file `.env` è escluso da git tramite `.gitignore`. **Non va mai committato.**

---

## 8. Avvio

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

All'apertura compare la pagina di **accesso**. Al primo avvio vengono creati due utenti:

| Utente | Password | Cosa vede |
|---|---|---|
| `test` | `test` | La piattaforma: Home, Documenti, Assistente AI, Dati |
| `admin` | `admin` | Tutto, più la voce **Amministrazione** |

Le password sono salvate come hash (scrypt) in `backend/storage/users.json`; quelle iniziali si cambiano nel `.env` (`DEFAULT_ADMIN_PASSWORD`, `DEFAULT_TEST_PASSWORD`) **prima** del primo avvio. Ogni utente ha la propria cronologia delle chat; l'archivio documenti è condiviso dal club. Se esisteva già un profilo da una versione precedente, diventa l'utente `admin` e mantiene le sue conversazioni. Per uscire c'è il pulsante in fondo al menu.

### Come si usa

| Area | Cosa fai |
|---|---|
| **Home** | Riepilogo: documenti, dataset, scadenze entro 90 giorni e conversazioni; **prossime scadenze** (contratti, certificati, sponsor, offerte) con i giorni rimanenti; documenti e chat recenti; domande di esempio |
| **Documenti** | Archivio con la **colonna delle categorie**. Carichi un file con il pulsante o trascinandolo: l'AI legge l'inizio e **propone categoria e titolo**, che puoi cambiare. Excel e CSV finiscono sempre in "Dati". Cerchi anche per persona o controparte, leggi, scarichi o elimini (i documenti ufficiali no) |
| **Lettore** | Mostra la **scheda dei dati chiave** estratti dall'AI e permette di cambiare categoria. Premi **Chiedi all'AI**: le domande sono limitate a quel file (o, per un Excel/CSV, l'analisi usa quei dati). Puoi passare alle domande generali con un clic |
| **Assistente AI** | La chat a tutta pagina con la cronologia. Dal pannello laterale il pulsante ⤢ porta qui la stessa conversazione |
| **Dati** | Scegli il dataset (partite o file caricati) e vedi numeri, passi di pulizia automatica, valori mancanti, anteprima delle righe pulite o grezze e schema delle colonne |
| **Amministrazione** (solo admin) | **Panoramica e costi**: spesa AI totale, ultimi 30 giorni, oggi, costo medio per domanda, grafico giornaliero, spesa per tipo di utilizzo, per utente e per modello. **Utenti**: elenco con conversazioni, domande, ricerche, caricamenti, token e spesa. **Attività**: storico di accessi, domande, ricerche, caricamenti e modifiche, filtrabile per utente e tipo. **Conversazioni**: le chat di tutti gli utenti, in sola lettura |

**Caricare un file**: trascinalo da Finder / Esplora risorse in qualsiasi pagina dell'app, oppure sul riquadro della finestra "Carica documento", oppure clicca il riquadro per sceglierlo.

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

## 9. Test

Il progetto ha test automatici per backend e data agent. **Non chiamano OpenAI** e non toccano i dati reali: profilo, documenti e dataset di prova finiscono in cartelle temporanee.

```bash
npm test                 # dalla root: tutti i test (macOS / Linux)
```

Oppure separatamente:

```bash
cd backend && npm test                                           # Node (node:test, nessuna dipendenza)
cd data_agent && .venv/bin/python -m pytest -q tests             # Python (pytest)
```

| Test | Cosa verifica |
|---|---|
| `backend/tests/chunker.test.js` | divisione per sezioni Markdown e per pagina, dimensione massima e sovrapposizione dei chunk |
| `backend/tests/categories.test.js` | categorie dell'archivio, categoria dalla sottocartella, formati supportati |
| `backend/tests/documentAi.test.js` | validazione delle risposte dell'AI (categoria proposta, date ISO, importi) |
| `backend/tests/deadlines.test.js` | calcolo dei giorni alla scadenza, ordinamento, scadenze passate |
| `backend/tests/agent.test.js` | definizione dei tool per il function calling, contenuto del system prompt, fonti |
| `backend/tests/http.test.js` | API reali su una porta casuale: login e sessione (401, cookie manomesso, blocco dopo 5 tentativi), permessi admin (403), storico delle ricerche, validazione della chat, upload rifiutati, path traversal |
| `backend/tests/usage.test.js` | hash delle password, firma e scadenza delle sessioni, prezzi dei modelli, calcolo della spesa e riepiloghi della dashboard |
| `data_agent/tests/test_cleaning.py` | il CSV ha ≥ 1000 righe e anomalie; dopo la pulizia 1.539 righe, niente duplicati, date, categorie e range corretti |
| `data_agent/tests/test_executor.py` | sandbox: esecuzione del codice pandas, blocco di lettura file (`.env`), rete, scrittura su disco, import, `eval`, attributi dunder, alias delle funzioni e timeout |
| `data_agent/tests/test_datasets.py` | pulizia dei CSV/Excel caricati: formati italiani (`€ 1.234,50`, `1.200.000`, `15%`, gg/mm/aaaa), duplicati, righe vuote |
| `data_agent/tests/test_api.py` | API FastAPI: health, panoramica, caricamento e rimozione di un dataset, validazione di `/analyze` |

---

## 10. Domande di esempio

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

## 11. Dati e knowledge base

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

## 12. Dettagli tecnici

### RAG custom (backend)
- **Estrazione del testo**: PDF pagina per pagina con `pdf-parse`, così le fonti citano la pagina; Word con `mammoth`; Markdown e TXT così come sono. I PDF scansionati, senza testo, vengono rifiutati con un messaggio chiaro.
- **Chunking per struttura**: il Markdown è diviso per titoli `##` e `###`, PDF e Word per pagina e paragrafo; i paragrafi troppo lunghi vengono spezzati per frasi (max ~1.400 caratteri, overlap di 200). Titolo del documento e sezione o pagina sono inclusi nel testo embeddato, per migliorare il retrieval.
- **Metadati**: ogni chunk porta `docId`, titolo, **categoria**, sezione o pagina, visibilità e proprietario. La ricerca può filtrare per categoria (parametro `category` del tool, scelto dall'LLM; se il filtro non trova nulla si ripete su tutto l'archivio) e, con un documento aperto, per `docId`.
- **Proposta di categoria e dati chiave**: al caricamento l'LLM (risposta in JSON) propone categoria e titolo leggendo l'inizio del testo; per contratti, sponsorizzazioni, area medica e mercato estrae persona, controparte, importo e data di scadenza. Le date in formato ISO alimentano l'endpoint delle scadenze e vengono passate all'orchestratore nel system prompt. Il filtro sui permessi (`visibility`/`ownerId`) è già presente nel codice, così si può reintrodurre facilmente una gestione multi-utente.
- **Embedding**: funzione di embedding custom per Chroma basata su OpenAI `text-embedding-3-small`, usata sia in indicizzazione sia in query.
- **Indice**: collection Chroma con distanza **coseno**. L'ingest è idempotente (`upsert` con id deterministici).
- **Retrieval**: top-4 chunk (5 dentro un singolo documento) con similarità, documento e sezione o pagina. Sono passati all'LLM con le etichette di fonte e mostrati nel frontend come link che aprono il documento alla pagina giusta.

### Orchestratore (backend)
- Function calling nativo dell'**SDK OpenAI**, senza framework, così il ciclo ReAct è esplicito e leggibile in `services/agentService.js` (system prompt in `prompts/systemPrompt.js`).
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

## 13. Scelte di design

- **Microservizio FastAPI invece di `child_process`.** La traccia ammette entrambe le strade. Un servizio sempre attivo carica e pulisce il CSV una sola volta all'avvio (invece che a ogni domanda), espone la documentazione su `/docs`, serve i grafici e si può testare da solo.
- **SDK OpenAI nativo invece di LangChain.** Il ciclo ReAct (ragiona → chiama uno strumento → osserva il risultato) è scritto in chiaro in `services/agentService.js`, così ogni passo è leggibile e tracciato nella risposta. Per lo stesso motivo il pandas agent è custom (vedi [Dettagli tecnici](#12-dettagli-tecnici)).
- **Backend a livelli.** `routes/` riceve le richieste e valida l'input, `services/` contiene la logica, `repositories/` legge e scrive su disco, `clients/` parla con OpenAI e con il data agent. `app.js` costruisce l'app senza avviarla, così i test la usano direttamente.
- **File JSON invece di un database.** Conversazioni e metadati dei documenti sono pochi e locali: file JSON con scrittura atomica bastano e non richiedono installazioni. ChromaDB resta il database dei contenuti dei documenti.
- **Un solo `.env` nella root**, letto da backend e data agent: una sola configurazione da preparare.
- **Pulizia deterministica prima dell'LLM.** Il dataset viene pulito da codice tracciato (`cleaning.py`), non dal modello: il risultato è ripetibile (1.578 → 1.539 righe) e ogni correzione compare nel report. L'agente può aggiungere pulizie specifiche per la domanda.
- **Funzioni oltre la traccia.** Archivio per categorie con caricamento da web, estrazione di scadenze e importi, analisi di Excel/CSV caricati. Nascono dallo scenario (un club gestisce contratti, certificati, sponsorizzazioni) e usano gli stessi due strumenti dell'agente: la chat resta il punto da cui si interroga tutto.

---

## 14. API

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
| `POST` | `/api/auth/login` | `{ username, password }` → cookie di sessione + profilo (pubblico) |
| `POST` | `/api/auth/logout` | Chiude la sessione |
| `GET` | `/api/me` | Utente collegato (401 senza sessione) |
| `POST` | `/api/activity/search` | `{ query, source }` → registra una ricerca nello storico |
| `GET` | `/api/admin/overview` | **Admin**: KPI di spesa e token (totale, 30 giorni, giornaliero, per tipo, modello e utente) |
| `GET` | `/api/admin/users` | **Admin**: utenti con conversazioni, domande, ricerche, caricamenti, token e spesa |
| `GET` | `/api/admin/activity` | **Admin**: storico attività (`?userId`, `?type`, `?limit`) |
| `GET` | `/api/admin/conversations` | **Admin**: conversazioni di tutti gli utenti (`?userId`) |
| `GET` | `/api/admin/conversations/:userId/:id` | **Admin**: una conversazione completa |

Tutte le API tranne `/api/health` e `/api/auth/*` richiedono il cookie di sessione (altrimenti `401`); quelle `/api/admin/*` rispondono `403` agli utenti non amministratori.

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

## 15. Sicurezza

- **Nessuna chiave nel codice**: tutte le credenziali sono lette da `.env` (`dotenv` / `python-dotenv`), che è escluso dal version control. Nel repository c'è solo `.env.example` con dei segnaposto.
- **Accesso con password**: le password sono salvate solo come hash scrypt con salt casuale. La sessione è un token firmato con HMAC-SHA256 in un cookie `HttpOnly` e `SameSite=Lax` (il JavaScript della pagina non può leggerlo); la chiave di firma viene dal `.env` o è generata al primo avvio in `backend/storage/`, mai nel codice. Dopo 5 tentativi sbagliati lo stesso utente viene bloccato per 5 minuti; i tentativi falliti compaiono nello storico dell'admin. Le API admin controllano il ruolo lato server (`403` per gli altri).
- `backend/storage/` (utenti, documenti, chat, storico attività e consumi, chiave delle sessioni) è escluso dal version control.
- **Esecuzione di codice generato dall'LLM** (il codice scritto da un LLM non è fidato: istruzioni nascoste in un documento o in un file caricato — *prompt injection* — potrebbero spingerlo a generare codice ostile). `executor.py` lo contiene con **quattro barriere indipendenti**:
  1. **Analisi AST**: blocca import non consentiti (solo pandas, numpy, matplotlib, seaborn, math, statistics, datetime, scipy, collections, itertools), funzioni pericolose (`open`, `exec`, `eval`, `__import__`, `getattr`...), gli attributi *dunder* (`__class__`, `__globals__`, `__subclasses__`...) e l'accesso diretto a `__builtins__`.
  2. **Builtins ridotti**: il codice gira con un `__builtins__` privo di `open`, `__import__`, `eval`, `getattr`...: anche aggirando l'AST, quelle funzioni non esistono nel namespace.
  3. **I/O neutralizzato**: pandas e numpy sono esposti al codice tramite un *proxy* che disattiva tutte le funzioni di lettura/scrittura di file o rete (`read_csv`, `to_csv`, `read_json` via URL, `np.load`, `savefig`...), senza modificare i moduli reali. Così il codice non può leggere il `.env` o altri file del server, né esfiltrare dati in rete. I grafici si salvano solo con la funzione `save_chart`.
  4. **Timeout**: il codice gira sotto un limite di tempo (`DATA_AGENT_EXEC_TIMEOUT`, default 15s); un ciclo troppo lungo viene interrotto senza bloccare il servizio.

  Queste barriere sono verificate da `data_agent/tests/test_executor.py` (lettura del `.env`, accesso alla rete, scrittura su disco, evasione via dunder, alias delle funzioni, timeout).
  *Limite noto*: non è una sandbox a livello di sistema operativo. Resta fuori portata il limite di memoria rigido e l'interruzione di un ciclo infinito "puro" senza I/O (Python non termina un thread dall'esterno). In produzione il data agent va comunque eseguito in un container isolato, senza rete e senza segreti nell'ambiente, con limiti di CPU e memoria imposti dal sistema.
- **Upload**: solo estensioni consentite (PDF, DOCX, TXT, MD, CSV, XLSX, XLS), massimo 20 MB, file salvati con nome casuale (id) fuori dalla cartella pubblica. Se l'indicizzazione fallisce, il caricamento viene annullato senza lasciare documenti a metà. Nell'HTML ricavato dai file Word vengono neutralizzati i link `javascript:`; il Markdown è mostrato senza HTML grezzo.
- Il data agent ascolta solo su `127.0.0.1`. Il backend valida l'input (lunghezza massima) e i nomi dei file dei grafici (regex, niente path traversal) e limita CORS all'origine del frontend.
- **Dati sensibili** (certificati medici, contratti, offerte di mercato): i file restano sul computer che esegue la piattaforma, ma i pezzi di testo vengono inviati a OpenAI per gli embedding, per l'estrazione dei dati chiave e, quando pertinenti, per le risposte. L'archivio è condiviso tra tutti gli utenti collegati. Per un uso reale servirebbero permessi per categoria (il filtro `ownerId`/`visibility` è già presente nei metadati), un accordo sul trattamento dei dati con il provider o un modello eseguito in locale.

---

## 16. Limiti noti

- **Accesso semplice.** Due ruoli (utente e admin), utenti creati al primo avvio, nessuna gestione degli utenti dall'interfaccia né cambio password; l'archivio documenti è condiviso. Il cookie non è `Secure` perché l'app gira in HTTP su localhost: in rete andrebbe servita in HTTPS.
- **Spesa stimata.** I costi sono calcolati dai token con un listino nel codice (`usageService.js`): la cifra fatturata è quella della dashboard OpenAI. I consumi si registrano da questa versione in poi.
- **Sandbox del codice solo applicativa.** I controlli AST di `executor.py` bloccano le operazioni pericolose più comuni ma non sostituiscono un container isolato, senza rete e con limiti di CPU e memoria.
- **Dati chiave estratti dall'AI.** Viene letta solo la parte iniziale del documento (circa 6.000 caratteri) e si estrae **una sola** scadenza per documento; i valori non si correggono a mano. La scheda nel lettore lo segnala ("da verificare sul documento").
- **Scadenze passate.** Nella Home restano visibili per 60 giorni, poi compaiono solo nel lettore del documento.
- **Excel.** Viene letto solo il primo foglio con dati.
- **PDF scansionati.** Senza OCR non contengono testo e vengono rifiutati.
- **Dati inviati a OpenAI.** Embedding, estrazione dei dati chiave e risposte passano dal provider (vedi [Sicurezza](#15-sicurezza)).
- **Costi.** Non c'è un limite di richieste: ogni domanda usa il modello di chat e, per le analisi, il pandas agent (2-5 chiamate). L'admin vede la spesa ma non può impostare un tetto.
- **Avvio con un comando** (`npm run setup`, `npm run dev`, `npm test`) solo su macOS e Linux; su Windows si usano i comandi separati.

---

## 17. Risoluzione dei problemi

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
