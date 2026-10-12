// icona (nome dell'icona SVG in Icon.jsx) ed etichette di ciascuno strumento dell'agente
const META = {
  search_knowledge_base: { icon: "docs", label: "Knowledge base (RAG)", short: "RAG" },
  analyze_data: { icon: "data", label: "Data agent Python", short: "Data agent" },
  // nome della prima versione (conversazioni salvate in precedenza)
  analyze_performance_data: { icon: "data", label: "Data agent Python", short: "Data agent" },
};

export function toolMeta(name) {
  return META[name] ?? { icon: "tool", label: name, short: name };
}
