-- WHICH KIND OF DEVICE A SESSION IS (2026-11-22): WEB (a browser) or APP (the «Zaki Orders» Android app).
--
-- Every existing row is a browser, so the default says so. sign-in.ts counts each kind on its own, so the app's
-- session never takes one of the two browser places and never signs a laptop out.
ALTER TABLE "user_sessions" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'WEB';
