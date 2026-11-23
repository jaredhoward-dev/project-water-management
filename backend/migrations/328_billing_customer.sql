-- 328_billing_customer — the billing account's customer at the payment
-- provider (issue #641 Phase 3, checkout and the Customer Portal;
-- docs/billing.md § Checkout and portal, docs/data-model.md § Billing).
--
-- Stripe's Customer Portal opens for a customer (`cus_…`), not for our
-- account, so the account remembers the customer checkout made for it. The
-- checkout route creates the customer before its first Checkout session and
-- stores it here; every later checkout and the portal reuse it.
--
--   1. billing_account.external_customer_ref: the provider's customer id,
--      unique (one customer is one account's). NULL until the first checkout
--      with the stripe provider (the mock and manual providers keep none).
--      Not personal information on its own, but it is the person's (their
--      data export includes it), and it goes with the account (323's ON
--      DELETE CASCADE from the person or team).
--   2. app_billing_customer_ref(account): the stored id, NULL unless the
--      caller is the account's person or an admin of its team
--      (app_billing_account_readable, 323).
--   3. app_billing_set_customer_ref(account, ref): the only writer. Sets the
--      id only while none is stored (the first wins, so two checkouts at once
--      keep one customer) and answers the stored one; NULL to anyone else.
--
-- water_app keeps no privilege on billing_account beyond 323's (none to
-- write), so nothing but these definer functions touches the column.

ALTER TABLE billing_account ADD COLUMN external_customer_ref text
	CONSTRAINT billing_account_customer_ref_shape CHECK (external_customer_ref IS NULL OR external_customer_ref ~ '^cus_[A-Za-z0-9]{1,250}$');
ALTER TABLE billing_account ADD CONSTRAINT billing_account_customer_ref_key UNIQUE (external_customer_ref);
COMMENT ON COLUMN billing_account.external_customer_ref IS
	'The payment provider''s customer for this account (Stripe''s cus_…), which its Customer Portal opens for (328, issue #641). Written only by app_billing_set_customer_ref.';

CREATE FUNCTION app_billing_customer_ref(p_account uuid) RETURNS text
	LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
	AS $$
	BEGIN
		IF NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		RETURN (SELECT external_customer_ref FROM billing_account WHERE id = p_account);
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_customer_ref(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_customer_ref(uuid) TO water_app;

CREATE FUNCTION app_billing_set_customer_ref(p_account uuid, p_ref text) RETURNS text
	LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public
	AS $$
	DECLARE
		v_ref text;
	BEGIN
		IF p_ref IS NULL OR NOT app_billing_account_readable(p_account) THEN
			RETURN NULL;
		END IF;
		UPDATE billing_account SET external_customer_ref = p_ref
			WHERE id = p_account AND external_customer_ref IS NULL;
		SELECT external_customer_ref INTO v_ref FROM billing_account WHERE id = p_account;
		RETURN v_ref;
	END
	$$;
REVOKE ALL ON FUNCTION app_billing_set_customer_ref(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_billing_set_customer_ref(uuid, text) TO water_app;
