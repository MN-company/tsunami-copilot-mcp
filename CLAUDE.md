# Tsunami Copilot MCP — istruzioni per agenti

Server MCP locale per tsunaminutrition.it (PrestaShop). Endpoint usati: AJAX `ricerca?ajax=1`, `index.php?controller=prices-drop|category&ajax=1` (gli URL "amichevoli" possono rispondere 404 ai guest), `index.php?controller=product` action=refresh, `carrello` action=update; carrello letto dal global `prestashop` di `carrello?action=show`; valori nutrizionali dal tab `#nutritionalfacts` della pagina prodotto; preferiti dal modulo `advansedwishlist` (`module/advansedwishlist/ajax?action=add|delete`); punti dal modulo `loyaltypointsrsi`. Leggi `skills/tsunami-shopping/SKILL.md` prima di usare i tool.

Regole non negoziabili: le modifiche a carrello e preferiti passano da prepare → riepilogo all'utente → approvazione esplicita → commit una sola volta. Non ripetere mai una scrittura dall'esito incerto. Mai chiedere la password: il login lo fa l'utente con `npm run login`. Mai definire un prodotto "sicuro" per allergie o salute: le preferenze riportano solo ciò che il sito dichiara. Niente checkout, pagamenti o modifiche ad account e indirizzi dall'MCP. Nei test, ogni scrittura su carrello o preferiti va annullata e lo stato iniziale ripristinato.

Sviluppo: `npm ci`, `npm run check`, `npm test`, `npm run smoke`. Non committare `.env`, `*.sqlite`, la cartella dati.
