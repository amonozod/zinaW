# Zina — o'z domeningga chiqarish

Papkada nimalar bor:

| Fayl | Nima qiladi |
|---|---|
| `index.html` | Student'lar uchun sayt (admin panel yo'q) |
| `admin.html` | Faqat sen uchun admin sayt: `https://SAYTING/admin` |
| `config.js` | Supabase kalitlari va to'lov linki (faqat shu faylni o'zgartirasan) |
| `supabase-shim.js` | Saytni Supabase va AI bilan ulaydigan ko'prik |
| `api/ai.js` | Zina AI serveri: plan limitini serverda tekshiradi va Claude'ga so'rov yuboradi |
| `supabase/schema.sql` | Baza jadvallari va xavfsizlik qoidalari |

`config.js` to'ldirilmaguncha sayt brauzerning o'zida demo rejimda ishlayveradi.

---

## 1. Supabase (baza + login) — 10 daqiqa

1. https://supabase.com da yangi project och. Region sifatida **Frankfurt (eu-central-1)** ni tanla, O'zbekistonga eng yaqini shu.
2. **SQL Editor** → New query → `supabase/schema.sql` faylini to'liq joylashtir → **Run**.
3. **Project Settings → API** bo'limidan uchta narsani ol:
   - `Project URL` va `anon public` kalitni → `config.js` ichiga yoz.
   - `service_role` kalitni → **hech qayerga yozma**, faqat 2-qadamda Vercel'ga qo'yasan.
4. **Authentication → Sign In / Providers**:
   - **Email**: tez boshlash uchun "Confirm email" ni o'chirib qo'ysang bo'ladi.
   - **Google**: Google Cloud'da OAuth client ochib, Client ID va Secret'ni shu yerga qo'y.
5. **Authentication → URL Configuration**: Site URL = saytingning manzili (masalan `https://zina.uz`), Redirect URLs'ga ham shuni qo'sh.

## 2. Vercel (hosting) — 5 daqiqa

1. Shu papkani GitHub'ga yukla va Vercel'da **Import Project** qil. Build sozlamasi kerak emas.
2. **Settings → Environment Variables** bo'limiga qo'sh:
   - `ANTHROPIC_API_KEY` — https://console.anthropic.com dan olinadi
   - `SUPABASE_URL` — Project URL
   - `SUPABASE_SERVICE_ROLE_KEY` — service_role kalit
3. **Redeploy** qil.

## 3. O'zingni admin qilish

Saytda ro'yxatdan o't, keyin Supabase SQL Editor'da shuni ishga tushir:

```sql
insert into admins (user_id)
select id from auth.users where email = 'SENING@EMAILING.com';
```

Keyin `https://SAYTING/admin` ga kirasan. Boshqa odam u yerga kirsa ham, "No access" ko'radi va hech narsani o'zgartira olmaydi, chunki buni baza qoidalari tekshiradi.

## 4. Savollarni eski saytdan ko'chirish

1. Eski (Claude'dagi) saytda: **Admin panel → Questions → Export → Copy**.
2. Yangi saytda: **Admin panel → Upload** ga joylashtir → **Split questions** → **Save**.
3. Full-length testlarni **Build a test** orqali qaytadan yig'asan, bu bir daqiqa ish.

## 5. Domain

Vercel → **Settings → Domains** → domeningni qo'sh. Vercel ko'rsatgan DNS yozuvlarini domain sotib olgan joyingda kiritasan. Keyin Supabase'dagi Site URL'ni ham yangi domainga almashtir.

## 6. To'lov — kartaga o'tkazma

1. Agar `schema.sql` ni avval ishga tushirgan bo'lsang, endi `supabase/update.sql` ni ham bir marta ishga tushir. Yangi project'da bu kerak emas.
2. `https://SAYTING/admin` → **Payments** → karta raqami, kartadagi ism, support linki (Telegram) va narxlarni (so'mda) kiritib **Save** bos.

**Qanday ishlaydi:**
- Student "Start 3-day free trial" ni bosadi → checkout sahifasi ochiladi → kartangga pul o'tkazadi → chek screenshotini yuklaydi va kartasining oxirgi 4 raqamini yozadi.
- Senda **Payments** bo'limida so'rov paydo bo'ladi. Chekni ko'rib **Approve** bosasan.
- Student'ning plani o'sha zahoti ochiladi: birinchi marta bo'lsa 3 kun bepul + 1 oy (yoki 3 oy). To'lov tasdiqlanmaguncha trial ishlamaydi.
- **Reject** bossang, student sababini ko'radi.
- Muddati tugaganda plan avtomatik Free'ga qaytadi. Student "Extend" bosib yana to'laydi, yangi muddat eskisining oxiriga qo'shiladi.

---

## Xavfsizlik (nima serverda himoyalangan)

- Savollar, testlar va so'zlarni **faqat admin** o'zgartira oladi (baza qoidalari bilan).
- Student faqat o'z to'lov chekini yubora oladi. Planni faqat sen tasdiqlaysan, uni hech kim o'zi yoqa olmaydi.
- Student faqat o'z postini yozadi va o'chiradi, like'da faqat o'zining like'ini qo'yadi yoki oladi, leaderboard'da faqat o'z qatorini yangilaydi.
- AI limiti (Free 0 / Pro 25 / Elite 80 kuniga) **serverda** tekshiriladi. Brauzerni aldab chetlab o'tib bo'lmaydi.
- `service_role` va Anthropic kalitlari faqat Vercel ichida saqlanadi, brauzerga hech qachon chiqmaydi.

## Hozircha qurilma ichida saqlanadigan narsalar

Student'ning shaxsiy progressi (javoblar tarixi, jadval, vocab, test natijalari) hozircha brauzerida saqlanadi. Boshqa qurilmadan kirsa, bu ma'lumotlar ko'rinmaydi. Keyingi bosqichda uni ham bazaga ulaymiz.
