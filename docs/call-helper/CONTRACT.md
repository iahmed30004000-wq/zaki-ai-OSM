# عقد «مساعد الاتصال» — التطبيق ↔ الـ OMS

العقد ثابت. التطبيق (`apps/call-helper-android/`) مبني عليه بالحرف، وجزء الـ OMS
(بابا `/api/call-helper/pair` و`/api/call-helper/reading`) بينبنى بـ PR لحاله عليه
بالحرف. أي تغيير فيه نسخة جديدة، مش تعديل هون.

النص كما انكتب:

---

- Package `io.zakiai.callhelper`, deep-link scheme `zakicall`.
- **Pair**: the web app opens `zakicall://pair?base=<https origin, url-encoded>&code=<one-time code, 32 url-safe chars>`. The app shows «ربط هذا الهاتف بحساب <base host>؟» with a button «اربط». It POSTs `<base>/api/call-helper/pair` JSON `{ "code": "...", "deviceName": "<Build.MANUFACTURER Build.MODEL>" }` → 200 `{ "token": "<opaque>", "userName": "<display name>" }` or 4xx `{ "error": "<arabic>" }`. Store base + token in private SharedPreferences (MODE_PRIVATE; use AndroidX security-crypto EncryptedSharedPreferences only if it builds cleanly, else plain private prefs). Only https bases accepted, except `http://10.0.2.2`/`http://localhost` in debug builds. A new pair replaces the old one. «افصل» button clears it.
- **Call**: the web app opens `zakicall://call?order=<orderId>&phone=<digits, international, no +>` (as an Android intent URL with a `tel:` browser fallback — the web side handles that). The app: if not paired or permissions missing → show why in Arabic with a button to fix, and offer «اتصل بدون المساعد» (ACTION_DIAL). Else ACTION_CALL `tel:+<phone>`, record `startedAt` (epoch ms) just before, watch the call state (TelephonyCallback on API 31+, PhoneStateListener below) until it goes OFFHOOK→IDLE or RINGING-less IDLE, then wait ~1.5 s and query `CallLog.Calls` for OUTGOING calls since `startedAt - 5s` whose number's last 8 digits match → `answered = duration > 0`, `talkSeconds = duration`, `ringSeconds` = (time from startedAt to OFFHOOK-when-answered is not available — compute ringSeconds as (call end − startedAt)/1000 − talkSeconds, floored at 0). POST `<base>/api/call-helper/reading` with header `Authorization: Bearer <token>` JSON `{ "orderId": "...", "phone": "<digits>", "startedAt": <ms>, "answered": true|false, "talkSeconds": n, "ringSeconds": n }` → 200 `{ "ok": true }`; 401 → token revoked: clear pairing and tell her to pair again; other errors → queue it in prefs and retry next time the app opens (max 20 queued, drop older than 24 h). Then `finish()` / `moveTaskToBack` so she lands back in Chrome on the same tab. Show a short toast/line «رد — ٢:١٣» or «ما رد — رنّ ٢٥ ث».
- Never read, keep or send any call that is not the one just placed (stage 2 — matching incoming calls — is NOT in this PR).
- Main screen (launcher): status (مربوط بـ… / مش مربوط), the three permissions with a grant button each, «افصل», version.

---

## كيف التطبيق بيقرا العقد (للي بيبني جزء الـ OMS)

| النقطة | شو بيعمل التطبيق |
|---|---|
| `base` | لازم يكون origin بس (`https://host[:port]`)؛ مسار أو query أو `user@` = الرابط مرفوض، مش مقصوص. |
| `code` | بالزبط 32 حرف من `A-Z a-z 0-9 _ -`. |
| `order` | 1–64 حرف من `A-Z a-z 0-9 _ -`. |
| `phone` | 6–15 رقم، بلا `+`. |
| رد الربط | 2xx بلا `token` = «رد الموقع مش مفهوم». 404 بلا `error` = «الموقع لسا ما فيه جزء الربط». أي 4xx فيه `error` بينعرض حرفياً. |
| رد القراءة | أي 2xx = انبعتت. 401 = الربط بينمسح (ومعه القراءات الناطرة). غير هيك = بتنحفظ وبتنبعت لما ينفتح التطبيق. |
| التكرار | القراءة الوحدة ممكن توصل مرتين (انبعتت والرد ضاع). مفتاحها `orderId` + `startedAt` — الباب لازم يعتبر التانية نفس الأولى. |
| المكالمة ما انلقت بالسجل | ما بينبعت شي، والتطبيق بيقلها «سجّلي النتيجة بإيدك». |
| إذا انقتل التطبيق نص المكالمة | أول ما ينفتح بيقرا نفس المكالمة من السجل وببعتها؛ `ringSeconds` = 0 إذا ما شاف نهايتها. |
| التحويل (redirect) | ما بيلحقه — الـ token ما بيروح لغير الـ base. |
