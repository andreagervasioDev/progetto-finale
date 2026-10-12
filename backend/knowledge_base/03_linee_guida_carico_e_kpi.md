# Linee Guida Monitoraggio del Carico e KPI di Performance

Documento: PERF-LG-02 · Versione 4.0 · Stagione 2025-26
Responsabile: Performance Manager, Area Performance del club
Destinatari: preparatori atletici, match analyst, staff tecnico, staff medico

## 1. Sistema di monitoraggio

Il club monitora ogni sessione e ogni partita con:
- **GPS a 18 Hz** indossato in un corpetto dedicato: distanza totale, distanza ad alta intensità, sprint, velocità massima;
- **RPE** (Rating of Perceived Exertion, scala CR-10) raccolto entro 30 minuti dalla fine della sessione;
- **Questionario di wellness** mattutino (sonno, fatica, dolori muscolari, stress, umore), sintetizzato in un punteggio da 1 a 10 dove **10 = condizione ottimale**;
- statistiche tecniche di partita fornite dal provider di event data (tiri, passaggi, xG, xA, duelli).

I dati confluiscono nel dataset `player_performance.csv`, una riga per calciatore per partita, esportato ogni settimana dal Performance Manager.

## 2. Glossario degli indicatori

| Indicatore | Colonna nel dataset | Definizione |
|---|---|---|
| Distanza totale | distance_km | Km percorsi in partita |
| HSR (High Speed Running) | hsr_distance_m | Metri percorsi sopra i **19,8 km/h** |
| Sprint | sprints | Numero di azioni sopra i **25,2 km/h** della durata di almeno 1 secondo |
| Top speed | top_speed_kmh | Velocità massima registrata |
| RPE | rpe | Sforzo percepito 1–10 |
| sRPE (carico di sessione) | rpe × minutes_played | Unità arbitrarie (UA) |
| Wellness | wellness_score | 1–10, sotto 5 = campanello d'allarme |
| xG (expected goals) | xg | Probabilità che un tiro diventi gol, sommata su tutti i tiri |
| xA (expected assists) | xa | xG dei tiri generati dai passaggi del calciatore |
| Rating | rating | Voto interno dello staff match analysis, scala 1–10 |

## 3. Soglie di carico e allerta

### 3.1 ACWR – Acute:Chronic Workload Ratio
L'ACWR confronta il carico dell'ultima settimana (acuto, 7 giorni) con la media settimanale delle ultime 4 settimane (cronico, 28 giorni), utilizzando come carico l'sRPE oppure i minuti giocati.

| ACWR | Zona | Azione |
|---|---|---|
| < 0,8 | Sotto-carico | Rischio da decondizionamento: integrare con lavoro aggiuntivo |
| 0,8 – 1,3 | **Zona ottimale ("sweet spot")** | Nessuna azione |
| 1,3 – 1,5 | Attenzione | Monitorare wellness, valutare riduzione del volume |
| > 1,5 | **Zona di pericolo** | Stato Giallo, riduzione del minutaggio, confronto con lo staff medico |

### 3.2 Altre soglie operative
- **Wellness < 5**: il calciatore segue una seduta ridotta; sotto 4 è necessaria la valutazione medica.
- **RPE ≥ 9** in due partite consecutive: giorno di scarico obbligatorio nella sessione successiva.
- **Calo della top speed** superiore al 5% rispetto alla media personale per 3 partite consecutive: segnale di affaticamento neuromuscolare, da segnalare al preparatore.
- **Minutaggio**: oltre 270 minuti in 8 giorni per i calciatori di movimento occorre una deroga dell'Allenatore (vedi Regolamento Interno).
- **Distanza per 90 minuti** inferiore dell'8% rispetto alla media stagionale personale per 3 gare consecutive: possibile calo di forma, da discutere nella riunione tecnica del lunedì.

## 4. Riferimenti per ruolo (valori medi per 90 minuti, Serie A)

Valori di riferimento utilizzati dallo staff per valutare il profilo fisico di un calciatore.

| Ruolo | Distanza (km) | HSR (m) | Sprint | Top speed attesa (km/h) |
|---|---|---|---|---|
| Portiere (POR) | 5,0 – 6,0 | 100 – 200 | 1 – 4 | 25 – 28 |
| Difensore (DIF) | 9,8 – 10,8 | 550 – 750 | 14 – 22 | 31 – 34 |
| Centrocampista (CEN) | 10,8 – 12,0 | 700 – 950 | 18 – 26 | 30 – 33 |
| Attaccante (ATT) | 9,6 – 10,8 | 800 – 1.050 | 24 – 34 | 32 – 35 |

## 5. Regole per le analisi dei dati

Per garantire confronti corretti tra calciatori, tutte le analisi prodotte dall'Area Performance devono rispettare le seguenti regole:
1. Le metriche offensive e fisiche si confrontano **per 90 minuti** (valore / minuti × 90).
2. Nei ranking per 90 minuti si considerano solo i calciatori con almeno **450 minuti giocati** nel periodo analizzato (equivalenti a 5 partite intere), per evitare distorsioni dovute a pochi minuti.
3. I **portieri** sono esclusi dalle classifiche offensive e fisiche e valutati con metriche dedicate.
4. I rating mancanti **non si imputano**: la media si calcola solo sulle partite con voto disponibile.
5. Le righe duplicate generate dal doppio export del sistema GPS vanno eliminate prima di qualsiasi analisi.
6. I valori fisicamente impossibili (per esempio top speed sopra i 40 km/h, minuti negativi o superiori a 120, distanze espresse in metri) sono errori di registrazione e vanno corretti o esclusi.

## 6. KPI di squadra e obiettivi stagionali 2025-26

| KPI | Obiettivo |
|---|---|
| Incidenza infortuni in partita | < 20 ogni 1.000 ore |
| Giorni persi per infortunio (totale rosa) | < 600 per stagione |
| Percentuale di calciatori in zona ACWR ottimale | > 80% delle settimane |
| Differenza gol fatti – xG di squadra | tra -5 e +5 (finalizzazione in linea con le occasioni) |
| Distanza media per 90' dei calciatori di movimento | ≥ 10,3 km |
| Wellness medio della rosa | ≥ 6,5 |
| Media punti per partita in Serie A | ≥ 1,7 (obiettivo qualificazione europea) |

## 7. Interpretazione di gol ed xG

- **Gol > xG** (sovraperformance): il calciatore finalizza meglio della media. Se la differenza è ampia e il campione è piccolo, è probabile una regressione verso la media nelle partite successive.
- **Gol < xG** (sottoperformance): il calciatore crea occasioni ma non le concretizza. Se il dato è persistente, va previsto lavoro specifico di finalizzazione.
- Lo staff considera significativa una differenza di almeno **±3 gol** su una stagione.

## 8. Calendario del reporting

| Report | Frequenza | Destinatari |
|---|---|---|
| Report post-gara (GPS + statistiche) | entro 24 ore dalla partita | Allenatore, preparatori |
| Report settimanale di carico e ACWR | ogni lunedì | Staff tecnico e medico |
| Report mensile KPI e infortuni | primo martedì del mese | Direzione Sportiva |
| Review di fine stagione | giugno | Direzione Sportiva, CdA |
