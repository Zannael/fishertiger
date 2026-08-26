# Modificatore Difesa: Piano Di Implementazione

## Principi non negoziabili

- [x] Mantenere storico, confronto giocatori, tassi di presenza, medie e calibrazione su tutte le 38 giornate di Serie A.
- [x] Usare l'intervallo selezionato nello slider soltanto per la lega corrente: consigli d'asta, strategia di rosa, valore stagionale atteso e simulazione.
- [x] Non attribuire un bonus fisso a portieri o difensori: il modificatore e' un valore di reparto, dipendente da formazione, rosa, presenze e alternative.
- [x] Conservare i vincoli d'asta esistenti come limiti invalicabili: credito disponibile, riserva per slot, incrementi, ruoli e completamento rosa.
- [x] Rendere ogni consiglio spiegabile: il valore dovuto al modificatore deve essere separato dal rendimento individuale.

## Stato attuale e correzioni di base

- [x] Rispettare `defense_modifier.enabled` nel simulatore browser.
- [x] Rendere identica la semantica del modificatore in Python e browser.
  - [x] Richiedere portiere con voto e almeno `required_defenders` difensori con voto.
  - [x] Calcolare la media con voto puro del portiere e migliori tre voti puri dei difensori.
  - [x] Selezionare la fascia piu' alta raggiunta.
  - [x] Non usare bonus, malus o fantavoti nella media difensiva.
  - [x] Non assegnare il bonus con formazione incompleta.
- [x] Estrarre una funzione browser pura per il calcolo del bonus e riusarla nel simulatore mock e nel valutatore d'asta.
- [x] Correggere il simulatore mock browser affinche' riconosca il calendario canonico e non generi un calendario fittizio quando il calendario reale e' presente.
- [x] Aggiungere vettori di parita' Python/browser per soglie, portiere, migliori tre difensori, quinto difensore e formazione incompleta.

## Orizzonti temporali

- [x] Formalizzare due orizzonti distinti nel modello.
  - [x] `historical_horizon`: sempre 38 giornate Serie A; usato per medie, tassi, varianza, confronti storici e calibrazione.
  - [x] `current_league_horizon`: giornate selezionate nello slider; usato per asta, valore strategico della rosa e simulazione corrente.
- [x] Verificare che nessun confronto con fonti storiche venga troncato in base allo slider della lega corrente.
- [x] Derivare gli indici Serie A del `current_league_horizon` dal calendario corrente quando disponibile.
- [x] Senza calendario di lega, usare il range selezionato per la proiezione strategica corrente, senza modificare i dati storici a 38 giornate.
- [x] Esporre nei risultati quale orizzonte e' stato usato per ogni metrica: `storico 38`, `lega corrente N`.

## Selezione della formazione

- [x] Definire la funzione obiettivo della formazione come punteggio individuale atteso piu' bonus difesa atteso quando il modificatore e' attivo.
- [x] Applicare la stessa funzione obiettivo nel simulatore Python, browser mock e valutatore d'asta.
- [x] Valutare tutte le formazioni consentite: un 4-3-3 o 4-4-2 puo' superare un 3-4-3 quando il bonus atteso compensa la differenza individuale.
- [x] Conservare le attuali regole di panchina, sostituzioni per ruolo e limite globale.
- [x] Esplicitare con test il comportamento di `Basic`, `Strict`, `None`, `zero_score`, `forfeit` e `allow_partial`.

## Modello marginale per asta e consigli

- [x] Implementare nel Web Worker un valore marginale del modificatore, non una quotazione statica per giocatore.
- [x] Per ogni candidato confrontare due scenari accoppiati:
  - [x] rosa con candidato;
  - [x] rosa con alternativa realistica dello stesso ruolo.
- [x] Usare l'alternativa gia' individuata dal motore al cutoff di domanda di lega, evitando di confrontare con uno slot vuoto.
- [x] Costruire completamenti plausibili della rosa incompleta dal pool residuo.
  - [x] completamento di mercato;
  - [x] completamento di maggior valore entro il budget;
  - [x] completamento economico e fattibile;
  - [x] completamento difensivo fattibile.
- [x] Pesare i completamenti in base a fattibilita', budget e stato di avanzamento dell'asta.
- [x] Per ogni completamento e giornata corrente:
  - [x] scegliere XI e panchina;
  - [x] estrarre presenze;
  - [x] applicare sostituzioni;
  - [x] estrarre voti puri;
  - [x] applicare il modificatore canonico;
  - [x] calcolare differenza candidato meno alternativa.
- [x] Usare numeri casuali comuni nei due scenari per ridurre rumore Monte Carlo.
- [x] Rendere il risultato deterministico con seed derivato da profilo, rosa, candidato, alternativa e contesto.
- [x] Partire con quattro contesti e 128 campioni accoppiati; aumentare i campioni solo vicino a soglie o cap d'offerta.
- [x] Memorizzare in cache proiezioni giornaliere, completamenti e valutazioni per non rallentare l'asta live.

## Integrazione nelle valutazioni

- [x] Separare contributo individuale e contributo marginale del modificatore.
- [x] Calcolare il margine corretto:

```text
margine corretto =
  contributo individuale candidato
  - contributo individuale alternativa
  + punti marginali attesi dal modificatore
```

- [x] Usare il margine corretto nell'ordinamento delle alternative, nel vantaggio qualitativo e nel `valueCap` del consiglio.
- [x] Non modificare la normalizzazione FVM sorgente nella prima versione.
- [x] Non modificare automaticamente le percentuali di budget per ruolo nella prima versione.
- [x] Convertire i punti marginali del modificatore in crediti con un prezzo-ombra per punto, stimato dal budget residuo e ristretto verso un prior di inizio asta.
- [x] Applicare inflazione di ruolo una sola volta, evitando doppio conteggio tra prezzo di mercato e bonus difesa.
- [x] Mantenere `legalMax`, riserva, cap morbido per ruolo e fattibilita' del completamento come vincoli finali.

## Priorita' e spiegazioni dei consigli

- [x] Aggiungere una metrica `defenseReadiness` alla panoramica della rosa.
- [x] Includere probabilita' di XI eleggibile, bonus medio condizionato, copertura in caso di assenze e probabilita' delle fasce.
- [x] Aumentare la priorita' dei difensori quando il quarto titolare affidabile rende il reparto eleggibile.
- [x] Aumentare la priorita' del portiere quando migliora in modo misurabile la probabilita' di fascia con i difensori posseduti.
- [x] Ridurre la priorita' quando il rendimento marginale del reparto e' gia' basso.
- [x] Mostrare nei consigli:
  - [x] punti individuali marginali;
  - [x] punti marginali del modificatore;
  - [x] probabilita' di eleggibilita' prima/dopo;
  - [x] probabilita' per fascia prima/dopo;
  - [x] incertezza della stima;
  - [x] ragione pratica, ad esempio: "quarto difensore titolare necessario".
- [x] Segnalare quando il budget difesa configurato limita un acquisto strategicamente valido, senza aggirarlo automaticamente.

## Impostazioni: stato delle modifiche

- [x] Correggere `mergeProfile()` affinche' conservi i valori salvati di `bench_switch`.
- [x] Separare nello stato applicativo:
  - [x] bozza del form;
  - [x] profilo salvato sul server;
  - [x] profilo applicato ai motori browser;
  - [x] profilo e fonti usati dall'ultimo dataset;
  - [x] profilo e dataset usati dall'ultima simulazione Monte Carlo.
- [x] Fare in modo che `Salva profilo` esegua realmente `PUT /api/profiles/:id`.
- [x] Non sostituire il profilo applicato in modo definitivo prima del successo del salvataggio o della generazione.
- [x] Dopo generazione, usare il profilo effettivo restituito dal server, inclusi partecipanti derivati dal calendario.
- [x] Estrarre una policy pura `profile-change-policy.js` che confronti baseline e bozza e classifichi ogni modifica.
- [x] Trattare `fantasy_matchdays` come derivato, non come modifica indipendente.
- [x] Conservare l'ordine semantico di moduli, tie-breaker, fasce, panchina e premi durante il confronto.

## Classificazione delle modifiche

- [x] Classificare come `rigenerazione dataset necessaria`:
  - [x] stagione, range e identita' del dataset;
  - [x] fonti correnti e storiche;
  - [x] contenuto di un file caricato anche se il percorso resta uguale;
  - [x] partecipanti e calendario di lega;
  - [x] valori di scoring che alimentano le proiezioni.
- [x] Classificare come `nuova simulazione necessaria`:
  - [x] modificatore difesa;
  - [x] moduli, panchina e sostituzioni;
  - [x] gol virtuali;
  - [x] classifica, spareggi e premi;
  - [x] quota di iscrizione;
  - [x] gestione formazione incompleta;
  - [x] slot rosa quando si aggiorna il report Monte Carlo.
- [x] Classificare come `applicazione immediata`:
  - [x] squadra utente;
  - [x] crediti iniziali d'asta;
  - [x] minimo, incremento, riserva e politica di chiamata;
  - [x] budget per ruolo e flessibilita';
  - [x] nome del profilo.
- [x] Quando una modifica appartiene a piu' classi, mostrare l'azione piu' forte richiesta.

## Freschezza di dataset e simulazione

- [x] Mantenere `configuration_hash` come identita' completa del profilo.
- [x] Aggiungere `dataset_input_hash` con soli input che richiedono rigenerazione.
- [x] Aggiungere `simulation_input_hash` con dataset, regole di simulazione e versione algoritmo.
- [x] Calcolare impronte delle fonti usate in generazione: almeno dimensione, data modifica e SHA-256.
- [x] Registrare nel dataset le impronte delle fonti, il profilo effettivo, hash, versione modello e identificativo generazione.
- [x] Registrare nella simulazione hash dataset, hash simulazione, seed, iterazioni, data e versione simulatore.
- [x] Rendere la sostituzione di un upload allo stesso percorso rilevabile come dataset obsoleto.
- [x] Impedire o avvertire chiaramente la simulazione server contro un dataset non compatibile con profilo o fonti correnti.

## UX delle Impostazioni e dashboard

- [x] Aggiungere un avviso persistente e non invasivo nella pagina Impostazioni.
- [x] Elencare i campi che hanno generato l'avviso.
- [x] Mostrare una delle tre azioni consigliate:
  - [x] `Salva modifiche`;
  - [x] `Salva e riesegui simulazione`;
  - [x] `Salva e rigenera dati`.
- [x] Consentire comunque il solo salvataggio, mantenendo lo stato di obsolescenza visibile.
- [x] Resettare la baseline soltanto dopo successo dell'operazione richiesta.
- [x] Mantenere lo stato sporco dopo errore di upload, salvataggio o generazione.
- [x] Aggiungere conferma interna e `beforeunload` solo quando la bozza e' realmente sporca.
- [x] Sostituire l'header sempre positivo `Dati aggiornati` con stati reali:
  - [x] dataset corrente;
  - [x] dataset da rigenerare;
  - [x] fonti cambiate;
  - [x] generazione in corso;
  - [x] generazione fallita;
  - [x] simulazione da aggiornare;
  - [x] simulazione in corso;
  - [x] simulazione non disponibile senza calendario.

## Test e calibrazione

- [x] Test Python per la semantica del modificatore: portiere, migliori tre, quinta scelta, fasce, soglie e formazione incompleta.
- [x] Test browser con gli stessi vettori di parita'.
- [x] Test di valore marginale: candidato uguale all'alternativa, quarto difensore, quinto difensore, portiere, varianza, modificatore disattivato e formazione impossibile.
- [x] Test del limite: il bonus puo' cambiare il consiglio ma mai superare vincoli legali o di completamento.
- [x] Test di riproducibilita' a seed e rosa invariati.
- [x] Test di classificazione di ogni categoria di impostazioni.
- [x] Test che il ripristino di un valore elimini lo stato sporco.
- [x] Test che un upload allo stesso percorso richieda rigenerazione.
- [x] Test che una generazione fallita non dichiari aggiornato un dataset vecchio.
- [x] Test che il report Monte Carlo sia marcato obsoleto dopo modifica delle sole regole di simulazione.
- [x] Calibrare il worker contro il simulatore Python con rose sintetiche e seed condivisi.
- [x] Misurare bias, errore standard, frequenze delle fasce e stabilita' della classifica dei candidati.

## Ordine di consegna

- [x] 1. Parita' del modificatore Python/browser e test di regressione.
- [x] 2. Distinzione esplicita tra storico a 38 giornate e orizzonte corrente della lega.
- [x] 3. Selezione formazione consapevole del modificatore.
- [x] 4. Policy pura delle modifiche impostazioni e correzione del salvataggio profilo.
- [x] 5. Hash, impronte fonti e stato di freschezza di dataset/simulazione.
- [x] 6. Avvisi, CTA e badge nella UI.
- [x] 7. Simulatore marginale accoppiato nel worker.
- [x] 8. Integrazione nei cap, alternative, priorita' e spiegazioni dei consigli.
- [x] 9. Calibrazione, test prestazionali e cache.
- [x] 10. Aggiornamento opzionale dell'asta casuale per simulare avversari sensibili al modificatore.
