# Protocollo Medico – Gestione Infortuni e Return-to-Play

Documento: MED-PRO-04 · Versione 2.1 · Revisione annuale: giugno 2026
Responsabile: Dott. Paolo Serra, Responsabile Area Medica del club
Destinatari: staff medico, fisioterapisti, preparatori atletici, staff tecnico

## 1. Obiettivi

Il protocollo definisce le procedure standard per la segnalazione, la diagnosi, il trattamento e il rientro in campo (Return-to-Play, RTP) dei calciatori infortunati, allo scopo di:
- ridurre il rischio di recidiva, che per gli infortuni muscolari nel calcio professionistico può superare il 12% quando il rientro è anticipato;
- uniformare le decisioni tra staff medico e staff tecnico;
- garantire tracciabilità e documentazione di ogni caso nel registro infortuni.

## 2. Definizione di infortunio

È registrato come **infortunio** qualsiasi evento fisico occorso durante allenamento o partita che impedisce al calciatore di partecipare pienamente alla seduta o alla gara successiva. Nel dataset di performance l'evento è marcato con `injury = 1`, la tipologia in `injury_type` e la stima dei giorni di stop in `days_out`.

Classificazione per gravità (in base ai giorni di assenza):
| Gravità | Giorni di stop |
|---|---|
| Minima | 1–3 giorni |
| Lieve | 4–7 giorni |
| Moderata | 8–28 giorni |
| Grave | oltre 28 giorni |

## 3. Procedura in caso di infortunio

1. **In campo**: il medico sociale valuta il calciatore entro 30 secondi dal segnale dell'arbitro. In caso di sospetta commozione cerebrale si applica il protocollo della sezione 6 e il calciatore **non può rientrare** in partita.
2. **Entro 2 ore**: il fisioterapista di turno compila la scheda evento sull'app Management AI (meccanismo, zona, lato, minuto).
3. **Entro 24 ore**: valutazione clinica completa ed eventuale diagnostica per immagini (ecografia o RM presso la clinica convenzionata). Per lesioni muscolari la RM si esegue tra le 24 e le 48 ore.
4. **Entro 48 ore**: il Responsabile Area Medica comunica allo staff tecnico la **prognosi** (giorni di stop stimati) e lo stato nel semaforo di disponibilità. La diagnosi resta riservata allo staff medico.
5. **Comunicazione esterna**: solo tramite comunicato ufficiale dell'Ufficio Comunicazione, previo consenso del calciatore.

## 4. Semaforo di disponibilità

| Stato | Significato | Conseguenze operative |
|---|---|---|
| **Verde** | Pienamente disponibile | Allenamento completo, convocabile |
| **Giallo** | Disponibile con limitazioni (affaticamento, rientro recente, wellness < 5, ACWR > 1,5) | Convocabile solo con parere medico, minutaggio limitato |
| **Rosso** | Non disponibile (infortunio in corso, RTP non completato, commozione cerebrale) | Non convocabile, lavoro differenziato |

Un calciatore passa automaticamente in **Giallo** quando si verifica almeno una delle seguenti condizioni:
- wellness score inferiore a **5** per due giorni consecutivi;
- rapporto carico acuto/cronico (ACWR) superiore a **1,5** (vedi Linee guida carico di lavoro);
- rientro da infortunio moderato o grave da meno di **14 giorni**;
- RPE di gara pari a 10 in due partite consecutive.

## 5. Protocollo Return-to-Play per infortuni muscolari

Il rientro è progressivo in **6 fasi**. Il passaggio alla fase successiva richiede il superamento dei criteri indicati e la firma del fisioterapista responsabile. Ogni fase dura almeno 24 ore.

| Fase | Contenuto | Criterio per avanzare |
|---|---|---|
| 1. Protezione | Riposo relativo, terapie, mobilità indolore | Assenza di dolore a riposo e nelle attività quotidiane |
| 2. Recupero funzionale | Palestra, bike, forza isometrica | Forza isometrica ≥ 80% dell'arto sano |
| 3. Corsa lineare | Corsa progressiva fino al 70% della velocità massima | Nessun dolore, forza ≥ 90% |
| 4. Lavoro sul campo individuale | Cambi di direzione, sprint fino al 90% della velocità massima, pallone | Raggiungimento di almeno il **95% della top speed** registrata dal GPS pre-infortunio |
| 5. Allenamento con la squadra | Seduta completa senza limitazioni | 2 sedute complete senza sintomi, wellness ≥ 6 |
| 6. Ritorno alla competizione | Convocazione con minutaggio progressivo | Prima gara massimo **45–60 minuti**, poi incremento graduale |

Nelle **prime 3 partite dopo il rientro** da un infortunio moderato o grave il carico di gara (sRPE) non deve superare il **110%** della media delle 4 settimane precedenti l'infortunio.

Tempi indicativi di recupero adottati dallo staff medico:
| Tipologia | Stop indicativo |
|---|---|
| Lesione muscolare flessori (bicipite femorale) | 14–35 giorni |
| Lesione muscolare polpaccio | 10–25 giorni |
| Lesione muscolare adduttori | 10–30 giorni |
| Distorsione caviglia | 7–28 giorni |
| Trauma contusivo | 3–10 giorni |
| Lesione legamentosa del ginocchio (LCA/LCM) | 60–180 giorni (LCA oltre 180) |
| Commozione cerebrale | minimo 7 giorni, di solito 7–14 |

## 6. Commozione cerebrale (concussion)

Il club adotta il protocollo "If in doubt, sit them out":
- in caso di sospetto il calciatore **esce immediatamente** dal campo e utilizza la sostituzione permanente per commozione prevista dal regolamento di competizione;
- la valutazione avviene con lo strumento SCAT6 entro 72 ore; il test di base è eseguito in pre-season per ogni calciatore;
- il rientro segue un percorso graduale in 6 step, di almeno 24 ore ciascuno, **con un minimo di 7 giorni** dall'evento prima di tornare a disposizione per una gara;
- a partire dalla seconda commozione nella stessa stagione è obbligatoria la consulenza neurologica e il periodo minimo sale a **21 giorni**.

## 7. Prevenzione

- Programma di prevenzione muscolare (Nordic hamstring, Copenhagen adduction) 2 volte a settimana per tutta la rosa.
- Screening di forza e mobilità a inizio stagione, a gennaio e al rientro da ogni infortunio grave.
- I calciatori con **2 o più infortuni muscolari** nella stessa stagione entrano nel programma individuale "High Risk" con monitoraggio settimanale del Responsabile Area Medica e del preparatore atletico.
- Calciatori con età superiore ai **30 anni**: almeno un giorno di recupero attivo aggiuntivo nelle settimane con due partite.

## 8. Reporting

- Ogni lunedì il Responsabile Area Medica invia all'Allenatore il report di disponibilità (stati verde/giallo/rosso).
- Ogni mese lo staff performance presenta l'**indice di incidenza infortuni** (infortuni ogni 1.000 ore di esposizione in partita) e il confronto con la stagione precedente. Obiettivo del club: **meno di 20 infortuni ogni 1.000 ore di partita**.
- Formula: incidenza = (numero infortuni in partita / minuti totali giocati) × 60.000.
