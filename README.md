# Tsunami Copilot MCP

Server MCP locale per fare acquisti su **tsunaminutrition.it**. Fa parte della suite integratori, insieme a Bulk e Prozis. Il sito è PrestaShop: questo MCP usa gli stessi endpoint AJAX e le stesse pagine del sito, con un limite di 1 richiesta al secondo.

## Avvio
```bash
npm ci
npm start            # http://127.0.0.1:3790/mcp
npm run smoke        # controllo live in sola lettura
npm test
```
Registrazione in Claude Code: `claude mcp add --transport http -s user tsunami http://127.0.0.1:3790/mcp`

Docker: `docker compose up -d --build` (immagine `tsunami-copilot-mcp:0.2.0`).

## Account
Senza login si usa un carrello **guest**, legato ai cookie salvati in `~/.tsunami-copilot/session-cookies.json` (0600). Per collegare il tuo account:
```bash
npm run login                     # accedi TU nella finestra del browser, poi premi INVIO
npm run login -- --logout
```
Se `npx playwright install chromium` non funziona, usa un Chromium già presente con `BROWSER_EXECUTABLE` (vedi `login-local.ps1`).

## Tool (27)
| Area | Tool | Stato |
|---|---|---|
| Sessione | `tsunami_session_status`, `tsunami_release_info` | verificato |
| Catalogo | `tsunami_search`, `tsunami_offers` (prezzi ribassati), `tsunami_categories`, `tsunami_category_products` | verificato |
| Prodotto | `tsunami_product_details` (con €/kg, €/g proteina, voto, preferenze), `tsunami_check_variant`, `tsunami_nutrition`, `tsunami_reviews` | verificato |
| Carrello | `tsunami_get_cart` (con spedizione), `tsunami_prepare_cart_change` → `tsunami_commit_cart_change`, `tsunami_cart_plan_status` | verificato; `reorder` in beta |
| Preferiti | `tsunami_wishlist`, `tsunami_prepare_wishlist_change` → `tsunami_commit_wishlist_change` | verificato |
| Account | `tsunami_orders`, `tsunami_order_get` | beta |
| Account | `tsunami_vouchers`, `tsunami_loyalty_points`, `tsunami_addresses`, `tsunami_payment_methods` | verificato (punti e indirizzi solo nello stato vuoto) |
| Preferenze locali | `tsunami_preferences_get`, `tsunami_preferences_set`, `tsunami_preferences_remove` | locale |
| Prezzi | `tsunami_price_history` | locale |

Note:
- **Filtri**: il sito non espone filtri a faccette (`rendered_facets` è vuoto). Prezzo minimo e massimo, "solo in sconto" ed esigenza alimentare (senza glutine, vegano, senza lattosio) sono quindi **filtri locali sulla pagina di risultati**, e valgono solo su ciò che il sito dichiara nel nome o nella descrizione.
- **Valori nutrizionali**: vengono dalla scheda "Tabella nutrizionale" della pagina prodotto. Spesso il sito li riferisce a un solo gusto (`tableFlavour`). `pricePerKg` e `pricePerGramProtein` sono calcolati solo quando peso e proteine sono noti, mai stimati.
- **Spedizione (Italia)**: gratis da 29 €, altrimenti 7 € (pagina Spedizione e Consegna, verificata anche nel carrello). Il riepilogo di `prepare` avvisa quanto manca alla soglia.
- **Sconto in elenco**: l'etichetta del sito a volte è sbagliata (es. "-181%"), quindi `discountPercent` viene ricalcolato da prezzo e prezzo di listino.
- **Preferiti**: se non esiste una lista, il sito crea "Preferiti". I prezzi nella pagina preferiti sono IVA esclusa (`priceExclVat`).
- **Riordino** (`op: "reorder"`): espande le righe di un ordine in aggiunte singole, ognuna con controllo live di variante, stock e prezzo. È in beta perché il parser del dettaglio ordine non è ancora verificato su un ordine reale; se non riconosce il formato risponde `PARSER_UNVERIFIED`.
- Dopo ogni commit il carrello o i preferiti vengono **riletti e confrontati**. Serve perché PrestaShop può rispondere "success" senza aver applicato la modifica: in quel caso lo stato è `unverified`.
- Restano esclusi di proposito: checkout, pagamenti e modifica di dati personali o indirizzi.
