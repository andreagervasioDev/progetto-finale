// Domande di esempio mostrate nella schermata iniziale e nella sidebar
export const SUGGESTIONS = [
  {
    group: "Knowledge base",
    kind: "rag",
    items: [
      "Quali sono le fasi del return-to-play dopo un infortunio muscolare?",
      "Che multa rischia un giocatore che arriva in ritardo di 20 minuti all'allenamento?",
      "Cosa prevede il protocollo in caso di commozione cerebrale?",
    ],
  },
  {
    group: "Analisi dati",
    kind: "data",
    items: [
      "Chi sono i 10 migliori marcatori nelle due stagioni? Confronta gol ed xG con un grafico.",
      "Come è cambiata la distanza media per 90 minuti per ruolo tra 2024-25 e 2025-26?",
      "Quali tipi di infortunio sono più frequenti e quanti giorni di stop causano in totale?",
    ],
  },
  {
    group: "Domande ibride",
    kind: "hybrid",
    items: [
      "Abbiamo rispettato l'obiettivo di incidenza infortuni previsto dal protocollo nella stagione 2025-26?",
      "Quali giocatori hanno un wellness medio sotto la soglia di allerta indicata nelle linee guida?",
      "Chi ha la differenza gol - xG più significativa secondo i criteri delle linee guida?",
    ],
  },
];
