# GROK_ANALYSIS_IMPORT_SPEC.md — Importación de Análisis de Grok

> Solo documentación/diseño. No implementar sin aprobación explícita.
> Branch: `jarvis-ui-overhaul` | Referencias: RESEARCH_INTAKE_PIPELINE.md, WATCHLIST_DECISION_SPEC.md

---

## 1. Cómo pegar un análisis de Grok

Pedro pega el texto del análisis de Grok directamente en Telegram o en el dashboard de Cordelius (campo de texto habilitado para intake). El sistema trata el input como texto no confiable y lo procesa en modo de extracción, no de ejecución.

### Formas de ingesta aceptadas

```
A. Telegram — mensaje de texto largo:
   Pedro escribe /import y pega el texto en el siguiente mensaje.
   Cordelius responde con el research item generado para confirmación.
   ⚠️ FUTURO — /import NO está en la whitelist activa de bot.js.
   Requiere PR separado con revisión de seguridad antes de habilitarse.

B. Dashboard web — campo "Pegar análisis":
   Pedro pega texto en el campo de intake y presiona "Procesar".
   Cordelius muestra el research item en pantalla para revisión.

C. Nota manual con estructura mínima:
   Pedro escribe: "Ticker: AMD, Tesis: IA adoption..."
   Cordelius completa el resto con los campos que pueda derivar.
```

> ⚠️ En ningún caso el análisis pegado ejecuta código ni genera órdenes.
> El texto se trata siempre como entrada de lectura, no de instrucción.
>
> ⚠️ El comando `/import` de Telegram es **conceptual** — no está implementado ni en la
> whitelist activa de `bot.js`. Habilitarlo requiere un PR dedicado con revisión de
> seguridad y actualización explícita de `REMOTE_CONTROL_PLAN.md`. Hasta entonces,
> la única forma de ingesta disponible es el dashboard web (opción B).

---

## 2. Cómo resumir el análisis

Jarvis aplica el siguiente proceso de resumen al texto de Grok:

```
1. Extraer oración(es) de tesis principal
   → Buscar: "I think", "the bull case is", "opportunity because", "strong buy", etc.
   → Resumir en ≤ 2 oraciones neutras, sin amplificar el entusiasmo del autor

2. Extraer precio objetivo si se menciona
   → Marcar como "precio objetivo según fuente" — no como precio confirmado
   → Nunca usar como referencia de ejecución

3. Extraer horizonte temporal
   → Si no se menciona: marcar como "indefinido"

4. Comprimir a máximo 3 párrafos
   → Párrafo 1: tesis
   → Párrafo 2: catalizadores
   → Párrafo 3: riesgos (incluyendo los omitidos por Grok)
```

---

## 3. Cómo extraer el ticker

```
Prioridad de extracción:

1. Ticker explícito en mayúsculas: $AAPL, $BTC, NVDA
   → Usar directamente si es inequívoco
   
2. Nombre de empresa conocido: "Apple", "Bitcoin", "AMD"
   → Mapear a ticker del portafolio o whitelist conocida
   → Si no está en la lista: marcar como "ticker pendiente de confirmación"

3. Descripción genérica: "semiconductor company", "crypto exchange"
   → NO inferir ticker
   → Marcar como RESEARCH_MORE, pedir confirmación a Pedro

4. Si hay ambigüedad: "Meta" → ¿META / metaverso / otra?
   → Preguntar: "¿Te refieres a META (Meta Platforms)?"
   → NO asumir
```

### Casos de no-inferencia

```
✗  "Esta cripto puede subir" → no extraer ticker
✗  "El exchange líder" → no asumir BNB, COIN, etc.
✗  "La empresa de Jensen Huang" → preguntar antes de asumir NVDA
✓  "$NVDA está en soporte de $120" → ticker: NVDA (confirmado)
✓  "Bitcoin (BTC) acumula..." → ticker: BTC (confirmado)
```

---

## 4. Cómo detectar sesgos y hype

Jarvis aplica un detector de sesgo al texto antes de extraer catalizadores.

### Señales de hype a marcar con ⚠️

```
Palabras/frases de alerta:
  "100x", "garantizado", "no puede bajar", "inminente moon",
  "todo el mundo va a comprar", "última oportunidad",
  "los institucionales están acumulando en secreto",
  "mi fuente interna dice", "en 30 días va a explotar"

Estructuras de sesgo:
  - Solo menciona upside, no menciona downside
  - Precio objetivo muy por encima del ATH sin respaldo fundamental
  - "Si no compras ahora vas a lamentarlo"
  - Énfasis en FOMO ("fear of missing out")
  - Comparaciones con activos que hicieron 10x en el pasado

Señales de análisis institucional serio (positivo):
  - Menciona riesgos explícitamente
  - Tiene horizonte temporal definido
  - Cita fuentes verificables (earnings, SEC filings, on-chain data)
  - Menciona condiciones de invalidación
```

### Output del detector

```json
{
  "biasScore": 65,
  "biasFlags": [
    "No menciona ningún riesgo en 800 palabras de análisis",
    "Usa lenguaje de urgencia: 'última oportunidad'",
    "Precio objetivo 3x en 30 días sin respaldo de valuación"
  ],
  "confidenceAdjustment": -15
}
```

> Un `biasScore > 70` reduce la confianza del research item y bloquea el avance a `PAPER_BUY`
> hasta que Pedro revise manualmente y confirme la tesis.

---

## 5. Separación de componentes del análisis

Todo análisis de Grok se descompone en 5 categorías antes de procesar:

### Hechos verificables

Afirmaciones que pueden contrastarse con datos reales. Se marcan como `FACT`.

```
Ejemplos:
✓ "BTC halving ocurrió en abril 2024" → verificable
✓ "NVDA reportó earnings de $26B en Q1 2025" → verificable
✓ "El ETF de BlackRock acumuló 300k BTC" → verificable (con fuente)
```

### Opiniones

Interpretaciones subjetivas del autor. Se marcan como `OPINION`.

```
Ejemplos:
~ "Creo que el mercado no ha descontado esto todavía"
~ "Los institucionales van a entrar masivamente"
~ "Es el mejor punto de entrada del año"
```

### Predicciones

Afirmaciones sobre el futuro sin respaldo factual inmediato. Se marcan como `PREDICTION`.

```
Ejemplos:
? "BTC va a llegar a $150k antes de fin de año"
? "NVDA va a doblar en 12 meses por demanda de chips IA"
? "El mercado va a ignorar la inflación este trimestre"
```

### Riesgos omitidos

Riesgos que Jarvis identifica como relevantes pero que el análisis de Grok no mencionó.
Se marcan como `OMITTED_RISK` con `⚠️`.

```
Ejemplos de omisiones comunes:
⚠️ No mencionó earnings en 10 días (riesgo binario)
⚠️ No mencionó posible regulación de SEC pendiente
⚠️ No mencionó correlación con macro (riesgo de risk-off)
⚠️ No mencionó concentración de supply en pocas wallets
```

### Catalizadores

Eventos o condiciones que podrían mover el precio según el análisis. Se marcan como `CATALYST`.

```
Ejemplos:
→ Aprobación de ETF en nuevo mercado (CATALYST: regulatorio)
→ Reducción de oferta post-halving (CATALYST: on-chain)
→ Partnership con empresa Fortune 500 (CATALYST: fundamental)
→ Inclusión en índice S&P 500 (CATALYST: institucional)
```

---

## 6. Prompt interno sugerido para Jarvis

Este es el prompt conceptual que Jarvis usaría internamente para procesar el análisis de Grok. No es código ejecutable — es la lógica que debe guiar la implementación.

```
SISTEMA: Eres Jarvis, el asistente de análisis de Cordelius.
Tu rol es extraer información estructurada de análisis externos de forma neutral.
No amplías el entusiasmo del autor. No inventas datos. No ejecutas órdenes.

INSTRUCCIONES:
1. Lee el análisis a continuación.
2. Extrae: ticker, tesis, catalizadores, riesgos, horizonte, precio objetivo (si se menciona).
3. Detecta señales de hype o sesgo. Marca con ⚠️ todo lo que parezca exagerado o sin respaldo.
4. Separa: hechos verificables (FACT) / opiniones (OPINION) / predicciones (PREDICTION) / riesgos omitidos (OMITTED_RISK) / catalizadores (CATALYST).
5. Si el ticker no es claro, responde: "Ticker no identificado. ¿Cuál es el símbolo?"
6. Si el análisis no tiene tesis clara, responde: "Tesis no identificada. ¿Puedes resumirla?"
7. NO generes un score de confianza mayor a 50 si no hay riesgos mencionados.
8. NO marques como PAPER_BUY sin que las condiciones externas (precio fresco, Jarvis mode, security audit) sean validadas después.

OUTPUT: JSON estructurado según RESEARCH_INTAKE_PIPELINE.md §4.

ANÁLISIS A PROCESAR:
[TEXTO DE GROK AQUÍ]
```

---

## 7. Output esperado en JSON conceptual

```json
{
  "id": "ri_20260615_002",
  "timestamp": "2026-06-15T02:00:00Z",
  "source": "grok",
  "rawInputSummary": "Análisis de Grok: AMD está en un punto de inflexión por demanda de chips IA...",
  "ticker": "AMD",
  "companyName": "Advanced Micro Devices",
  "assetType": "stock",
  "exchange": "NASDAQ",
  "thesis": "AMD podría beneficiarse del ciclo de capex en IA, especialmente en data centers con su línea MI300.",
  "catalysts": [
    "Adopción de MI300X en clusters de IA de hiperescaladores",
    "Crecimiento de mercado de CPUs de servidor (EPYC)"
  ],
  "risks": [
    "Competencia intensa de NVIDIA en GPU IA (market share 80%+)",
    "⚠️ Earnings en 12 días — no mencionado en el análisis (OMITTED_RISK)",
    "⚠️ Exposición a China: restricciones de exportación pendientes (OMITTED_RISK)"
  ],
  "classifiedClaims": [
    { "type": "FACT",         "text": "Competencia intensa de NVIDIA en GPU IA (market share 80%+)" },
    { "type": "FACT",         "text": "MI300X en uso por Microsoft y Meta para inferencia" },
    { "type": "CATALYST",     "text": "Adopción de MI300X en clusters de IA de hiperescaladores" },
    { "type": "CATALYST",     "text": "Crecimiento de mercado de CPUs de servidor (EPYC)" },
    { "type": "OMITTED_RISK", "text": "Earnings en 12 días — no mencionado en el análisis" },
    { "type": "OMITTED_RISK", "text": "Exposición a China: restricciones de exportación pendientes" },
    { "type": "PREDICTION",   "text": "$200 antes de fin de año — sin modelo de valuación" },
    { "type": "OPINION",      "text": "El mercado no ha descontado el potencial de IA de AMD" }
  ],
  "bias": {
    "biasScore": 45,
    "biasFlags": [
      "Precio objetivo de $200 sin modelo de valuación explícito"
    ],
    "confidenceAdjustment": -5
  },
  "timeHorizon": "6-12 meses",
  "confidence": 62,
  "riskLevel": "medium",
  "marketDataStatus": "unavailable",
  "marketDataNote": "Precio AMD no disponible en tiempo real en Cordelius",
  "technicalStatus": "unknown",
  "jarvisMode": "MODERADO",
  "healthContext": "recovery: 72, sleep: 80",
  "securityAuditStatus": "pass",
  "status": "WATCHLIST",
  "nextAction": "Verificar precio y técnico en TradingView antes de avanzar. Confirmar situación de earnings."
}
```

---

## 8. Ejemplo completo de entrada y salida

### Entrada (texto de Grok — ficticio)

```
AMD está en un punto de inflexión muy interesante. El MI300X está ganando tracción 
en los data centers más grandes del mundo. Microsoft y Meta ya lo están usando para 
inferencia a escala. El EPYC sigue tomando market share de Intel en servidores.

En mi opinión, AMD podría llegar a $200 antes de fin de año. 
No veo cómo puede bajar mucho desde aquí.

El mercado no ha descontado el potencial de IA de AMD porque todos están 
obsesionados con NVIDIA. Esta es la oportunidad silenciosa del año.

[Precio al momento del análisis: $145 USD — ficticio]
```

### Análisis de Jarvis

```
FACT:      MI300X en uso por Microsoft y Meta para inferencia (verificable)
FACT:      EPYC ganando market share de Intel en servidores (verificable con IDC data)
OPINION:   "El mercado no ha descontado el potencial de IA de AMD"
PREDICTION: "$200 antes de fin de año" — sin modelo de valuación
OMITTED_RISK ⚠️: No menciona earnings en ~12 días (riesgo binario)
OMITTED_RISK ⚠️: No menciona restricciones de exportación a China (AMD tiene exposición)
OMITTED_RISK ⚠️: NVIDIA tiene ~80% de market share en GPU IA — riesgo de ejecución AMD
HYPE ⚠️: "No veo cómo puede bajar mucho desde aquí" — lenguaje de certeza sin respaldo
HYPE ⚠️: "Oportunidad silenciosa del año" — FOMO implícito

biasScore: 55 (moderado — tiene hechos verificables pero también lenguaje de hype)
confidenceAdjustment: -8
confidence final: 62 → 54 (ajustado) → redondeado a 55
```

### Resumen en Telegram

```
📋 Research item — AMD (NASDAQ)
Fuente: Grok | Estado: WATCHLIST
Tesis: AMD podría beneficiarse del ciclo de capex en IA via MI300X y EPYC.
Confianza: 55/100 (ajustada por hype detectado) | Riesgo: MEDIUM

⚠️ Riesgos omitidos en análisis original:
  - Earnings en ~12 días (sin confirmar fecha exacta)
  - Restricciones de exportación a China
  - Dominio de NVIDIA en GPU IA no mencionado

⚠️ Hype detectado: "no veo cómo puede bajar" / "oportunidad del año"

💹 Precio AMD no disponible en tiempo real en Cordelius.
   Revisar manualmente: https://www.tradingview.com/chart/?symbol=NASDAQ:AMD

¿Qué hacemos?
/watchlist AMD → agregar a watchlist
/reject AMD    → rechazar y archivar
/research_more AMD → pedir más información
```

> ⚠️ Datos de entrada y salida en este ejemplo son completamente ficticios.
> Los precios, scores y diagnósticos no representan ninguna situación real de AMD.

---

## 9. Limitaciones de este pipeline con Grok

```
✗  Grok puede alucinar datos de precio, earnings o eventos — siempre verificar
✗  Grok puede tener sesgo bullish si el prompt del usuario fue optimista
✗  Los catalizadores de Grok pueden estar desactualizados (knowledge cutoff)
✗  Grok no tiene acceso a datos en tiempo real en todos los contextos
✓  Lo que Grok sí puede aportar bien: estructura de tesis, catalizadores cualitativos
✓  Lo que Jarvis debe verificar siempre: precio, técnico, earnings date, riesgo regulatorio
```

---

## 10. Referencias cruzadas

| Documento | Relación |
|---|---|
| `RESEARCH_INTAKE_PIPELINE.md` | Pipeline completo del que este es parte |
| `WATCHLIST_DECISION_SPEC.md` | Qué pasa con el item después de WATCHLIST |
| `PAPER_TRADING_SPEC.md` | Condiciones para avanzar a paper trade |
| `CODEMAP.md` | computeJarvisBrain(), cryptoQuotes, buildSecurityAudit() |
| `REMOTE_CONTROL_PLAN.md` | Comandos Telegram disponibles |

---

*GROK_ANALYSIS_IMPORT_SPEC.md | 2026-06-15 | Solo documentación — no implementar sin aprobación*
