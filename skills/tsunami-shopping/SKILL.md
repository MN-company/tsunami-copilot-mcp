---
name: tsunami-shopping
description: Fare acquisti di integratori su Tsunami Nutrition tramite il server MCP tsunami (tsunami_* tools).
---
1. `tsunami_session_status`: capisci se il carrello è del cliente o guest.
2. Per trovare prodotti usa `tsunami_search`, `tsunami_offers` (prezzi ribassati) oppure `tsunami_categories` → `tsunami_category_products`. I filtri (prezzo, sconto, esigenza alimentare) sono locali e valgono solo sulla pagina di risultati: dillo all'utente quando li usi.
3. `tsunami_product_details` dà opzioni, €/kg, €/g di proteina, voto e indicazioni sulle preferenze. `tsunami_nutrition` dà la tabella completa, `tsunami_reviews` le recensioni. La disponibilità cambia per gusto: verificala con `tsunami_check_variant`.
4. Per confronti di convenienza usa `pricePerGramProtein` solo quando presente. Se manca, il dato non è pubblicato: non stimarlo.
5. `tsunami_prepare_cart_change` (add, update, remove, voucher_apply, voucher_remove, reorder): mostra righe, prezzi, spedizione (gratis da 29 €, altrimenti 7 €) e avvisi, poi chiedi conferma.
6. Solo dopo un "sì" esplicito in un messaggio successivo: `tsunami_commit_cart_change`. Lo stesso flusso vale per i preferiti (`tsunami_prepare_wishlist_change` → `tsunami_commit_wishlist_change`).
7. `unverified`, `COMMIT_UNCERTAIN` o un errore: NON ripetere. Rileggi con `tsunami_get_cart` o `tsunami_wishlist` e mostra all'utente lo stato reale. `CART_REJECTED` vuol dire che il sito ha rifiutato (es. coupon inesistente) e non ha cambiato nulla.
8. Codici sconto disponibili: `tsunami_vouchers`. Punti: `tsunami_loyalty_points`. Metodi di pagamento (solo i nomi): `tsunami_payment_methods`.
9. Per pagare manda l'utente su https://www.tsunaminutrition.it/carrello?action=show.
Niente consigli medici o di dosaggio. Le preferenze (`tsunami_preferences_*`) segnalano solo ciò che il sito dichiara. Non dire mai che un prodotto è "sicuro" per un'allergia: le caratteristiche come "Senza Glutine" sono dichiarazioni del sito, non garanzie.
