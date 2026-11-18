/**
 * «قاعدة وحدة» — THE TWO OLD SWITCHES TAKE NO MORE WRITES (the owner's plan of 17/11, request C2, decision 7).
 *
 * «نظام الجولات» and «الطلب يرجع للطابور فوراً» left «قواعد مركز التأكيد»: the one rule («إثبات المكالمات وجدول المحاولات») replaced them. Their doors keep GET
 * (what is stored can still be read) and answer every write with this 409 — nothing is written, not the switch, not its date, not an audit line. Their STORED values
 * stay exactly as they are (no migration, no job rewrites them): with the plan off they still work as on main — the way back. Their engine code leaves later (C4).
 */
export const RETIRED_SWITCH_CODE = 'RULE_RETIRED';
export const RETIRED_SWITCH_AR = 'هالمفتاح انشال — صار في قاعدة وحدة بـ«قواعد مركز التأكيد» (إثبات المكالمات وجدول المحاولات). ما انحفظ شي.';
