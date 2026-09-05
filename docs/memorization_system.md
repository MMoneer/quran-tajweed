# نظام الحفظ والمراجعة — تقرير تفصيلي

> **Quran.com Tajweed Mushaf — Memorization & Spaced Repetition System**
>
> النسخة: **V3 (Schema 3)**
> النطاق: تطبيق صفحة واحدة يعمل أوفلاين بالكامل، بدون أي اعتماد على API خارجي.
> الوثائق المرجعية: `js/memorizationEngine.js`, `js/memorizationView.js`, `js/dateUtils.js`, `js/indexedDbAdapter.js`, `js/backupValidator.js`, `project-helper/progress_plan.md`.

---

## ١. فلسفة التصميم والمعمارية

التطبيق يتبع معمارية صارمة بطبقات منفصلة، حيث لا توجد طبقة تعرف بتفاصيل الطبقة التي تحتها:

```
┌──────────────────────────────────┐
│   UI (MemorizationView)          │  ← عرض فقط، بدون منطق جدولة
├──────────────────────────────────┤
│   Engine (MemorizationEngine)    │  ← منطق الأعمال (scheduling)
├──────────────────────────────────┤
│   Persistence (IndexedDbAdapter) │  ← تخزين أوفلاين
├──────────────────────────────────┤
│   Meta (QuranMetaService)        │  ← حسابات مواضع القرآن
├──────────────────────────────────┤
│   Quran Data (data/juz-data.js)  │  ← مصدر الحقيقة (read-only)
└──────────────────────────────────┘
```

**المبادئ الأساسية:**

1. **Stateless Engine** — محرك الحفظ لا يحمل حالة داخلية، بل يستقبل `state` ويعيده معدّلاً. هذا يجعل الاختبار أسهل ويسمح بإلغاء التغييرات (Undo) دون آثار جانبية.
2. **No business logic in UI** — واجهة المستخدم تستدعي فقط دوال المحرك، ولا تحتسب أي `interval` أو `easeFactor`.
3. **Offline-first** — كل شيء يعمل بدون إنترنت، مع مزامنة بين التبويبات عبر حدث `storage`.
4. **Deterministic IDs** — كل نطاق محفوظ له معرّف ثابت مشتق من موقعه في القرآن (`fromSurah:fromAyah-toSurah:toAyah`)، مما يمنع تكرار العناصر.
5. **Local Calendar Dates** — كل التواريخ تُحسب وفق التقويم المحلي للمستخدم، وليس UTC، لتفادي انزياح التاريخ قرب منتصف الليل.

---

## ٢. نموذج البيانات (Schema V3)

حالة الحفظ بأكملها مخزنة في كائن واحد:

```js
{
  version: 3,

  plan: {                            // خطة الحفظ
    isActive: false,                 // هل الخطة مفعّلة؟
    targetType: 'ayahs',             // 'ayahs' | 'surah' | 'page'
    dailyAmount: 5,                  // عدد الآيات/السور/الصفحات يومياً
    direction: 'forward',            // 'forward' | 'backward' — اتجاه الحفظ
    currentSurah: 1,                 // مؤشر التقدم الحالي
    currentAyah: 1,
    isCompleted: false               // وصل إلى آخر آية في القرآن؟
  },

  day: {                             // حالة اليوم
    date: 'YYYY-MM-DD',              // تاريخ اليوم (محلي)
    newMemorizationCompleted: false, // هل تم حفظ نطاق اليوم؟
    todayRange: { from, to, count }, // نطاق اليوم (مُثبَّت)
    completedReviewIds: [],          // IDs المراجعات المكتملة اليوم
    dueReviewIds: []                 // IDs المجموعة المجمّدة لمراجعات اليوم
  },

  stats: {                           // إحصاءات
    currentStreak: 0,                // السلسلة الحالية
    longestStreak: 0,                // أطول سلسلة
    totalReviews: 0,                 // إجمالي المراجعات
    lastCompletedDay: null           // آخر يوم اكتملت فيه الخطة
  },

  items: [],                         // النطاقات المحفوظة + حالتها في SRS
  badges: [],                        // الإنجازات المفتوحة
  _undoSnapshot: null                // لقطة داخلية (لا تُحفظ أبداً)
}
```

### بنية العنصر (`item`)

```js
{
  id: '2:1-2:5',                    // معرّف ثابت
  fromSurah: 2, fromAyah: 1,        // بداية النطاق
  toSurah: 2, toAyah: 5,            // نهاية النطاق

  repetition: 0,                    // إجمالي المراجعات الناجحة
  consecutiveSuccesses: 0,          // سلسلة النجاحات المتتالية

  interval: 1,                      // الفاصل الحالي (أيام)
  easeFactor: 2.5,                  // معامل السهولة (1.3 - 3.0)

  lastReviewed: null,               // آخر تاريخ مراجعة
  nextReview: 'YYYY-MM-DD',         // تاريخ الاستحقاق القادم

  status: 'learning'                // المرحلة الحالية
}
```

---

## ٣. التعامل مع التواريخ (`DateUtils`)

**المشكلة التي يعالجها:** استخدام `toISOString().split('T')[0]` يُحوّل إلى UTC ويُمكن أن يزيّف التاريخ للمستخدمين في مناطق زمنية غير UTC.

**الحل:** جميع التواريخ تُحسب من مكونات `Date` المحلية:

```js
getLocalDateString(date = new Date())   // → "2026-09-04"
addDays(dateString, days)               // جمع/طرح أيام
daysBetween(date1, date2)               // فرق الأيام
isToday(dateString)                     // هل هو اليوم؟
isYesterday(dateString)
parseLocalDateString(s)                 // يحلل YYYY-MM-DD بدقة
```

**سلوكيات مضمونة:**

- الانتقال بين الأشهر والسنوات يُحسب صحيحاً (مثلاً: `2026-12-31 + 1` → `2027-01-01`).
- `addDays` يقبل كسور (تُقسم إلى أرضية `Math.trunc`).
- أي سلسلة تاريخية مكسورة تُسبب `throw` لمنع الأخطاء الصامتة.

---

## ٤. الجدولة الذكية: خوارزمية "Quran Adaptive Spaced Repetition"

ليست SM-2 صرفة، بل تكيُّف محلي. تستخدم **أربعة تقييمات** فقط:

| التقييم | المعنى | التأثير |
|:---:|:---|:---|
| **١ (فشل)** | لم يستطع التذكر | تصفير عدّادات + تقليص `easeFactor` |
| **٢ (صعب)** | تذكّر بصعوبة | تقليص `easeFactor` قليلاً |
| **٣ (جيد)** | تذكّر طبيعي | بدون تعديل على `easeFactor` |
| **٤ (سهل)** | تذكّر بسهولة | زيادة `easeFactor` |

### منطق الفشل (rating = 1)

```
repetition            = 0
consecutiveSuccesses  = 0
interval              = 1
easeFactor            = max(1.3, easeFactor - 0.2)
lastReviewed          = today
nextReview            = today + 1 day
```

### منطق النجاح (rating ∈ {2, 3, 4})

**الفترات الأولية الثابتة:**
```
نجاح 1  →  1 يوم
نجاح 2  →  3 أيام
نجاح 3  →  7 أيام
نجاح ≥4 →  round(interval × easeFactor)
```

**تعديل `easeFactor`:**
```
صعب (2):  easeFactor -= 0.15   (بحد أدنى 1.3)
جيد (3):  بدون تعديل
سهل (4):  easeFactor += 0.15   (بحد أقصى 3.0)
```

**ثم:**
```
repetition           += 1
consecutiveSuccesses += 1
lastReviewed          = today
nextReview            = today + interval يوم
status                = computeStatus(item)
```

**المعامل `easeFactor` مقيّد بـ [1.3, 3.0]** — يضمن أن لا تتسبب التقييمات المتطرفة في جدولة غير واقعية.

---

## ٥. مراحل العنصر (`status`)

محسوبة تلقائياً بعد كل مراجعة:

| المرحلة | الشرط | الفترة التقريبية |
|:---|:---|:---|
| **learning** (قيد التعلم) | أقل من ٢ نجاح متتالي | < ٣ أيام |
| **reviewing** (مراجعة) | interval < 8 | ٣-٧ أيام |
| **consolidating** (تثبيت) | interval 8-21 | ١-٣ أسابيع |
| **stable** (مستقر) | interval 22-44 | ٣-٦ أسابيع |
| **mastered** (متقن) | **interval ≥ 45 و consecutiveSuccesses ≥ 5** | شهر+ |

**القاعدة الذهبية للإتقان:** يجب توفر **الشرطين معاً** — لا يكفي طول الفترة وحدها، ولا تتابع النجاحات بدون فاصل طويل.

**الكود:**
```js
function computeStatus(item) {
  const s = item.consecutiveSuccesses;
  const i = item.interval;
  if (s < 2) return STATUS.LEARNING;
  if (i >= 45 && s >= 5) return STATUS.MASTERED;
  if (i >= 22) return STATUS.STABLE;
  if (i >= 8) return STATUS.CONSOLIDATING;
  return STATUS.REVIEWING;
}
```

---

## ٦. آلية العمل اليومية (Daily Flow)

### ٦.١ ضمان اليوم الحالي (`ensureCurrentDay`)

عند كل عملية، يستدعي المحرك هذه الدالة. إذا كان التاريخ المحفوظ ≠ تاريخ اليوم المحلي:
- تتم تصفير `newMemorizationCompleted`
- تتم تصفير `completedReviewIds`
- يُحدَّث `day.date` إلى اليوم
- **لا تتأثر** `items` ولا `stats` ولا `plan` ولا `badges`.

### ٦.٢ نطاق الحفظ الجديد (`completeNewMemorization`)

**سلوك idempotent** — يُستدعى بأمان عدة مرات في نفس اليوم:

1. تحقق: هل `newMemorizationCompleted`؟ إن نعم، أعد العنصر الحالي بدون إنشاء جديد.
2. حسب نطاق جديد عبر `computeNextPlanRange`:
   - **`ayahs`** → `currentAyah` إلى `currentAyah + dailyAmount - 1` (مع اجتياز حدود السور).
   - **`surah`** → السورة كاملة من الموقع الحالي.
   - **`page`** → الصفحة الكاملة من موقع المصحف (يحتاج `PageIndex`).
3. أنشئ عنصراً بمعرّف ثابت (`buildItemId`)، أو استخدم الموجود إن وُجد.
4. **التقدم التلقائي للمؤشر:** انتقل إلى الموضع الذي يلي النطاق المُحفظ. إن وصلنا إلى آخر آية في القرآن (114:6)، تُوسم الخطة `isCompleted = true`.
5. اضبط `nextReview = today + 1`.
6. تحقق من اكتمال اليوم → إن نعم، حدّث السلسلة.

### ٦.٣ قائمة مهام اليوم (`getDailyTaskSummary`)

يُعيد كائناً واحداً متكاملاً للواجهة:

```js
{
  date,                         // تاريخ اليوم
  newMemorization: { from, to, count },  // نطاق الحفظ الجديد
  dueReviews: [...items],       // المراجعات المستحقة (المجموعة المجمّدة)
  completedReviewIds: [...],    // ما أُنجز منها
  remainingReviewIds: [...],    // ما تبقى منها (متراكمة، خارج المجموعة)
  newMemorizationCompleted,     // هل سُجِّل حفظ اليوم؟
  allReviewsCompleted,          // هل كل عناصر المجموعة المجمّدة مكتملة؟
  dayCompleted,                 // هل اليوم مُكتمَل رسمياً؟
  streak,                       // السلسلة الحالية
  cohortCap                     // حجم المجموعة المجمّدة (= 3 × dailyAmount)
}
```

**ملاحظات:**

- نطاق الحفظ الجديد يُخزَّن في `day.todayRange` من داخل
  `completeNewMemorization` نفسه — قبل تقدّم المؤشر. هذا يضمن أن
  `todayRange` يطابق النطاق الفعلي المُحفظ، حتى لو استدعى المُتصل
  الدالة مباشرةً دون استدعاء `getDailyTaskSummary` أولاً.
- المجموعة المجمّدة `day.dueReviewIds` تُبنى في أول استدعاء لـ
  `getDailyTaskSummary` (lazy) وتبقى ثابتة لبقية اليوم.

---

## ٧. الأولوية والحد اليومي للمراجعات (مجموعة مجمّدة)

### ٧.١ الفرز الحتمي (`getOverdueItems`)

كل العناصر المستحقة (`nextReview ≤ today`) تُرتَّب بثلاث مفاتيح:

```
1. nextReview  أبكر تاريخ أولاً (الأكثر تأخراً)
2. interval    الفاصل الأصغر أولاً (الأكثر إلحاحاً)
3. id          معجمياً (لضمان التحديد المطلق)
```

هذا يجعل الترتيب **deterministic** تماماً، مما يُسهّل الاختبار ويُجنّب التذبذب البصري.

### ٧.٢ المجموعة المجمّدة (Frozen Cohort) — `dueReviewIds`

عند إنشاء قائمة مهام اليوم لأول مرة (`getDailyTaskSummary`)، يبني المحرك
**مجموعة مجمّدة** من IDs المراجعات المستحقة، بحجم `3 × plan.dailyAmount`:

- المجموعة **مُثبَّتة طوال اليوم**: مراجعة عنصر لا تَعِد ترتيب المجموعة
  ولا تُدخل عناصر من backlog إلى حصة اليوم.
- العناصر خارج المجموعة تبقى مستحقة للغد (لا تُحسب مكتملة).
- تُحفظ المجموعة في `day.dueReviewIds`، وتُمسح عند انتقال اليوم
  المحلي (`ensureCurrentDay`).
- **التوافق العكسي**: النسخ القديمة V3 التي تخلو من `dueReviewIds` يتم
  حساب المجموعة لها تلقائياً عند أول وصول (lazy init).

```
plan.dailyAmount = 5  →  dailyReviewCap = 15
plan.dailyAmount = 10 →  dailyReviewCap = 30
```

### ٧.٣ اشتقاق اكتمال اليوم (`isDayCompleted`)

```
خطة نشطة + !newMemorizationCompleted  →  false
وإلا تحقق: هل كل IDs المجموعة المجمّدة ضمن completedReviewIds؟
```

---

## ٨. السلسلة (Streak) — قواعد صارمة

**لا تُحدَّث السلسلة إلا عند اكتمال اليوم فعلاً.**

```
state.stats.lastCompletedDay === today         →  لا تغيير (تجنب التكرار)
state.stats.lastCompletedDay === (today - 1)   →  currentStreak += 1
أي حالة أخرى                                →  currentStreak = 1
```

ثم:
```
if (currentStreak > longestStreak)
    longestStreak = currentStreak
state.stats.lastCompletedDay = today
awardBadges(state)
```

**ضمانات:**

- مراجعة واحدة لا تكفي لكسر/بناء السلسلة.
- تخطي يوم يعيد السلسلة إلى ١.
- الإنجازات تُمنح تلقائياً عند الوصول إلى العتبات.

---

## ٩. نظام التراجع (Undo)

نافذة تراجع **٥ ثوانٍ** بعد كل مراجعة:

### آلية العمل

1. **قبل** تطبيق التقييم، يُلتقط snapshot كامل للحالة القابلة للتعديل (`takeSnapshot`).
2. يُعرض toast فيه عدّاد تنازلي (٥ → ٤ → ٣ → ٢ → ١ → ٠).
3. إن ضغط المستخدم "تراجع":
   - تُستعاد اللقطة في الذاكرة.
   - يُحفظ التغيير في IndexedDB.
   - تُرسَل إشارة مزامنة بين التبويبات.
4. بعد ٥ ثوانٍ أو أي تفاعل آخر، تختفي النافذة.

### ضمانات اللقطة

`takeSnapshot` ينسخ **نسخة عميقة بطبقة واحدة** لكل من:
- `plan`
- `day` (مع نسخ `todayRange` و `completedReviewIds` و `dueReviewIds`)
- `stats`
- `items` (كل عنصر على حدة)
- `badges`

هذا كافٍ لأن المراجعات لا تعدّل عنصراً في مكانها — بل تستبدله كلياً.

### حماية المحرك ضد التقييمات الخاطئة

`reviewItem` يرمي في الحالات التالية:

1. **التقييم غير صالح** (ليس 1/2/3/4).
2. **العنصر غير موجود**.
3. **نفس العنصر قُيّم سابقاً اليوم** (`completedReviewIds` يحتوي الـid).
4. **العنصر خارج المجموعة المجمّدة** (`dueReviewIds`).
5. **العنصر لم يحن موعده بعد** (`item.nextReview > today`).

الواجه تُزامن هذا الحارس بقفل جميع أزرار التقييم عبر
`setReviewButtonsLocked(true)` أثناء رحلة الحفظ (re-entrancy guard) لمنع
النقرات السريعة المتعددة قبل إعادة الرسم.

### التراجع عند فشل الحفظ

إن فشلت `saveState` في IndexedDB بعد تعديل في الذاكرة، تستعيد الواجهة
الحالة من لقطة ما قبل التعديل بدلاً من تعديل الذاكرة فقط. هذا
ينطبق على:

- `onReview` (مراجعة جديدة)
- `onCompleteNew` (حفظ نطاق جديد)
- `onSavePlanEditor` (تعديل الخطة)
- `onStopPlan` (إيقاف الخطة)
- `onResetItem` (إعادة ضبط عنصر)

الآلية: `MemorizationView.persist` يُعيد `boolean`؛ عند `false` تستبدل
الواجهة الحالة بـ `JSON.parse(JSON.stringify(state))` (نسخة ما قبل
التعديل) وتُسقط `_undoSnapshot` لتفادي "تراجع" على الحالة المُعادة.

---

## ١٠. إعادة الضبط اليدوية (`resetItem`)

عملية متاحة لكل عنصر (زر "إعادة ضبط" في الواجهة):

**التأكيد مطلوب** قبل التنفيذ.

**التأثير:**
```
status                = 'learning'
repetition            = 0
consecutiveSuccesses  = 0
interval              = 1
easeFactor            = 2.5
lastReviewed          = null
nextReview            = today + 1
```

**ملاحظات:**
- العنصر لا يُحذف — يبقى في السجل.
- الإحصاءات (`stats`) وشارات الإنجاز (`badges`) لا تتأثر.
- تُلتقط لقطة undo قبل التنفيذ.

---

## ١٠.١ إعادة الضبط الشاملة (منطقة الخطر)

زر "إعادة ضبط الحفظ والمراجعة بالكامل" في قسم النسخ الاحتياطي يستدعي
`onResetAll` في الواجهة:

1. **تأكيدان متتاليان** عبر `confirm()` — الأول يذكِّر بأن المسح لا
   يمكن التراجع عنه، والثاني تأكيد نهائي.
2. `MemorizationEngine.resetAllState()` تُعيد `createInitialState()`
   كاملاً (`_undoSnapshot = null`) — تُمحى النطاقات والإحصاءات
   والإنجازات والخطة.
3. تُحفظ الحالة الجديدة في IndexedDB وتُرسَل إشارات المزامنة.
4. عند فشل الحفظ تظهر رسالة خطأ (لا توجد حالة سابقة يمكن استعادتها —
   المسح نفسه هو العملية المرغوبة).

---

## ١١. خطة الحفظ وأنواع الأهداف

ثلاثة أنواع مدعومة:

| النوع | المعنى | الحساب |
|:---|:---|:---|
| **ayahs** | عدد آيات يومياً | `calculateNextAyahRange(start, dailyAmount)` |
| **surah** | سورة كاملة يومياً | `calculateNextSurahRange(surah, ayah)` |
| **page** | صفحة مصحف يومياً | `calculateNextPageRange(page)` (يحتاج `PageIndex`) |

### اتجاه الخطة (`plan.direction`)

- **`forward` (الافتراضي):** ينتقل المؤشر نحو آخر القرآن (الناس)، وتُحسب
  النطاقات بـ `calculateNext*Range`.
- **`backward`:** ينتقل المؤشر نحو أول القرآن (الفاتحة)، وتُحسب النطاقات
  بـ `calculatePrevious*Range` — الاتجاه المعتاد للحفظ من البقرة نحو
  البداية. تغيير الاتجاه **لا يلمس** العناصر أو الإحصاءات أو الإنجازات.

حالات خاصة في الاتجاه العكسي:
- **وضع ayahs:** يعبر حدود السور نحو البداية، ويتوقف عند 1:1 بوضع
  `isCompleted = true`.
- **وضع surah:** النطاق = بداية السورة حتى موقع المؤشر (إذا كان المؤشر
  منتصف السورة، يعلق عليه أولاً).
- **وضع page:** نفس الاقتصاص — إذا كان المؤشر منتصف صفحة، ينتهي النطاق
  عند المؤشر بدلاً من نهاية الصفحة.

قيمة `direction` تُحفظ في الخطة وتُصدَّر/تُستورد مع النسخ الاحتياطية.
النسخ القديمة بدونها تُقرأ كـ `'forward'`.

**سيناريوهات الحدود** التي يضمنها `QuranMetaService`:

```
2:284 + 3  →  2:284–2:286     (آخر آيتين من البقرة)
2:286 + 1  →  3:1             (بداية آل عمران)
... + N    →  قد يعبر سوراً متعددة
114:6      →  isCompleted = true
```

**في حالات الفشل** (مثلاً: موقع غير صالح)، ترمي الدالة `RangeError` وتلتقطها الواجهة وتعرض رسالة خطأ.

**محرر الخطة** (`<dialog>` أصلي):
- نوع الهدف (آيات/سورة/صفحة) — أزرار segmented.
- اتجاه الحفظ (من البداية للنهاية / من النهاية للبداية) — أزرار segmented.
- عدد الآيات اليومي — stepper (يظهر فقط في وضع ayahs).
- السورة الحالية — قائمة منسدلة بأسماء السور من `DataStore.getChapters()`.
- الآية الحالية — رقم مع التحقق من الحد الأقصى للسورة.

**حدود الإدخال الصارمة (أثناء الكتابة نفسها وعند الحفظ):**
- **عدد الآيات اليومي:** ٤ خانات كحد أقصى ولا يتجاوز `6236` (عدد آيات
  القرآن). اللصق أو الكتابة الزائدة تُقتطع فورًا، وزر `+` يتوقف عند 6236.
- **رقم الآية:** ٣ خانات كحد أقصى (لا سورة تتجاوز ٢٨٦ آية)، ولا يتجاوز
  عدد آيات السورة المختارة — يُعاد التحقق عند تغيير السورة.
- عند "حفظ التغييرات" تُطبَّق نفس القيود مرة أخيرة دفاعًا عن القيم
  المُدخَلة قبل هذه الحدود أو من حالات استثنائية.

عند أي تعديل، يُستدعى `updatePlanPointer` (للخطة النشطة) أو `activatePlan` (للتشغيل الأول)، والذي:
- يُتحقق من حدود السورة.
- **لا يُعلِّم `isCompleted` لمجرد نقل المؤشر إلى 114:6** — الاكتمال يحدث فقط عند تسجيل النطاق النهائي عبر `completeNewMemorization`.
- **تحرير خطة مكتملة إلى موقع أبكر صحيح يُعيدها إلى وضع قابل للتنفيذ** (`isCompleted = false`).
- يُعيد ضبط `day.newMemorizationCompleted = false` (لأن المستخدم غيّر نيته).
- **لا يمس** `items` أو `stats` أو `badges`.

---

## ١٢. نظام الإنجازات (Badges)

أربعة عشر إنجازاً idempotent — سبعة عامة وسبعة على تقدّم الأجزاء:

| المعرّف | الشرط | الرمز |
|:---|:---|:---:|
| `first_portion` | إتمام حفظ الجزء الأول كاملاً (الفاتحة + أول ١٤١ آية من البقرة = ١٤٨ آية) | 🌱 |
| `streak_7` | سلسلة ٧ أيام | 🔥 |
| `streak_30` | سلسلة ٣٠ يوماً | 🏆 |
| `ayahs_100` | ١٠٠ آية محفوظة | 📖 |
| `ayahs_500` | ٥٠٠ آية محفوظة | 📚 |
| `ayahs_1000` | ١٠٠٠ آية محفوظة | 🏅 |
| `first_mastered` | أول عنصر في مرحلة الإتقان | ⭐ |
| `juz_1` | جزء واحد مكتمل | 🥉 |
| `juz_5` | ٥ أجزاء مكتملة | 🥈 |
| `juz_10` | ١٠ أجزاء مكتملة | 🥇 |
| `juz_15` | ١٥ جزءاً مكتملاً | 💎 |
| `juz_20` | ٢٠ جزءاً مكتملاً | 🕌 |
| `juz_25` | ٢٥ جزءاً مكتملاً | 🌟 |
| `juz_30` | القرآن كاملاً (٣٠ جزءاً) | 👑 |

**الآلية:** تُمنح عبر `awardBadges()` (تُستدعى بعد كل عملية)، وتستخدم `Set` داخلياً ثم تُسلسل كقائمة. لا يمكن منح إنجاز مرتين.

---

## ١٣. الإحصاءات (`getStatistics`)

مُشتقّة بالكامل من البيانات (لا تكرار):

```js
{
  totalMemorizedAyahs: 124,           // اتحاد فريد لكل نطاقات الحفظ
  byStatus: {                         // عداد لكل مرحلة
    learning: 12, reviewing: 8,
    consolidating: 4, stable: 3, mastered: 2
  },
  totalReviews: 587,
  currentStreak: 14,
  longestStreak: 21,
  dueReviewCount: 15,                 // حجم المجموعة المجمّدة (3 × dailyAmount)
  backlogCount: 7,                    // overdue − dueReviewCount
  completedJuz: 4,                    // عدد الأجزاء المكتملة (يغذي شارات juz_*)
  lastCompletedDay: '2026-09-03'
}
```

**`computeTotalMemorizedAyahs`** يحسب الاتحاد الفريد للآيات عبر النطاقات
(التداخل يُحسب مرة واحدة)، مع حد أمان `6236` لمنع الانهيارات في حالة
بيانات فاسدة.

---

## ١٤. التخزين في IndexedDB (`IndexedDbAdapter`)

### بنية قاعدة البيانات

```
DB_NAME     = 'quran_memorization_db'
DB_VERSION  = 1
STORE_NAME  = 'state'      // متجر واحد
KEY         = 'singleton'  // سجل واحد يحمل كل الحالة
```

### `saveState(state)`

- **Deep-clone** قبل الكتابة → لا يُعدَّل كائن المتصل.
- **حذف صريح** لـ `_undoSnapshot` قبل وضعها في المتجر (لا تتسرب أبداً للقرص).
- استخدام معاملة `readwrite` كاملة مع معالجة شاملة للأخطاء (`onerror`, `onabort`, `tx.oncomplete`).
- في حالة `QuotaExceededError`، يُرفع `Error` وصفي للواجهة.
- **ضمان:** أي `Promise` مُحقق = حالة محفوظة فعلياً.

### `loadState()`

- معاملة `readonly`.
- إن لم يكن هناك سجل → يُرجع `null`.
- حذف دفاعي لـ `_undoSnapshot` (احتياط ضد تخزين قديم فاسد).

### `clearState()`

- معاملة `readwrite` + `store.clear()`.

### `initDB()`

- **Idempotent**: يُحفظ `_initPromise` → الاستدعاءات المتزامنة تشترك في نفس الوعد.
- ينشئ `objectStore` إن لم يكن موجوداً (في `onupgradeneeded` أو داخل callback الـ upgrade).
- يرفض عند `onblocked` (متصلا آخر يحجب الترقية).

### معالجة الفشل

في `MemorizationView.persist`:
```js
try {
  await adapter.saveState(state);
  showTransientToast(messageOnSuccess, false);
} catch (e) {
  showTransientToast('تعذر حفظ التغيير. يرجى المحاولة مجدداً.', true);
}
```

**لا يُبلَّغ** المستخدم بنجاح قبل التحقق الفعلي من اكتمال المعاملة.

---

## ١٥. النسخ الاحتياطي والاستعادة (`BackupValidator`)

### `exportBackup(state)`

1. ينسخ الحالة عميقاً.
2. يحذف `_undoSnapshot`.
3. يمر عبر `validateBackup` (يفشل برمي `Error` إذا كانت الحالة غير صالحة).
4. يُسلسل كـ JSON بإزاحة ٢ مسافة.

### `validateBackup(data)`

يقبل إما سلسلة JSON أو كائناً. **لا يرمي أبداً** — دائماً يُرجع:
```js
{ valid: true, sanitizedData } | { valid: false, error }
```

**يتحقق من:**
- `version === 3`
- `plan`: `isActive` (boolean), `targetType` (في المجموعة), `dailyAmount` (≥1), `direction` (إن وُجد: `'forward'` أو `'backward'` فقط — يُرفض أي غيرهما، والغياب يُقرأ `'forward'`), `isCompleted` (boolean), `currentSurah/currentAyah` (موضع قرآني صحيح).
- `day`: `date` (YYYY-MM-DD), `newMemorizationCompleted` (boolean), `completedReviewIds` (مصفوفة سلاسل), `todayRange` (كائن أو null).
- `stats`: `currentStreak/longestStreak/totalReviews` (أعداد صحيحة غير سالبة), `lastCompletedDay` (تاريخ أو null).
- **كل عنصر في items:**
  - `id` يجب أن يساوي `buildItemId(from, to)` بالضبط.
  - `fromSurah:fromAyah` و `toSurah:toAyah` مواقع صحيحة في القرآن.
  - `repetition` و `consecutiveSuccesses` غير سالبين.
  - `interval` ≥ 1.
  - `easeFactor` في [1.3, 3.0].
  - `status` ضمن المجموعة المسموحة.
  - `nextReview` و `lastReviewed` بصيغة صحيحة.
- `badges`: كل عنصر معروف من المجموعة المسموحة.

### `migrateBackup(rawData)`

**للترقية من نسخ سابقة (V1/V2)**:

- **plan:** يُحفظ ما هو صالح، يُعطى قيمة افتراضية للباقي، المواقع خارج النطاق → إصلاح إلى (1,1).
- **day:** تاريخ غير صالح → اليوم المحلي.
- **stats:** الأعداد السالبة تُصلح إلى ٠.
- **items:** يُسقط كل عنصر غير قابل للإصلاح. **رفض كامل** إن كانت `items` المُدخَلة غير فارغة ولا شيء بقي فيها.
- **badges:** تُحفظ فقط المعروفة.

### تدفق الاستيراد في الواجهة

```
1. قراءة الملف كنص.
2. JSON.parse.
3. إن كانت النسخة ≠ 3 → migrateBackup.
4. validateBackup.
5. إن فشل التحقق → عرض رسالة خطأ في حقل ملاحظات.
6. تأكيد المستخدم (confirm).
7. استبدال الحالة + ensureCurrentDay + saveState.
8. عرض ملاحظة نجاح.
```

---

## ١٦. المزامنة بين التبويبات

عند تحديث الحالة، يُرسل التبويب المُحدِّث إشارتين:

```js
localStorage.setItem('quran_memorization_update', String(Date.now()));
window.dispatchEvent(new Event('quran_memorization_state_changed'));
```

في `init`، يُسجَّل مستمعان:

```js
window.addEventListener('storage', e => {
  if (e.key === 'quran_memorization_update') reloadFromStorage();
});
window.addEventListener('quran_memorization_state_changed', reloadFromStorage);
```

`reloadFromStorage` يعيد قراءة الحالة من IndexedDB و `ensureCurrentDay` و `render`.

**النتيجة:** فتح التطبيق في تبويبين متزامنين — أي حفظ في أحدهما ينعكس فوراً في الآخر.

---

## ١٧. واجهة المستخدم (`MemorizationView`)

### المكونات المعروضة (Cards)

1. **Header** — العنوان والوصف.
2. **Plan Card** — حالة الخطة:
   - **لا توجد خطة:** زر "اختر خطة الحفظ" → فتح محرر الخطة.
   - **خطة نشطة:** الهدف اليومي، الموقع الحالي، أزرار (تعديل / إيقاف).
   - **خطة مكتملة:** رسالة تهنئة وزر "إيقاف".
3. **New Memorization Card** — نطاق اليوم:
   - فارغ/تم حفظه/قابل للحفظ مع زر "تم الحفظ".
4. **Reviews Card** — قائمة مراجعات اليوم:
   - إن لم تكن هناك مستحقات: رسالة "لا توجد مراجعات مستحقة اليوم، بارك الله فيك!".
   - إن وُجدت: قائمة مع ٤ أزرار تقييم لكل عنصر + شارة المرحلة + زر "إعادة ضبط".
5. **Backlog Alert** — تنبيه بعدد المراجعات المؤجلة.
6. **Stats Section** — شبكة من ٤ بطاقات إحصاء + قائمة توزيع المراحل.
7. **Badges Section** — الإنجازات المكتسبة.
8. **Backup Section** — تصدير / استيراد JSON.

### ملاحظات واجهة مهمة

- **RTL** كامل — كل النصوص بالعربية.
- **Arabic-Indic digits** عبر `toArabicDigits()` (داخل `VerseClipboard` أو fallback محلي).
- **`esc()`** دفاعي قبل أي حقن HTML.
- **`dialog` أصلي** (`<dialog>`) لمحرر الخطة مع `aria-labelledby`, `role="radiogroup"`, `aria-checked`.
- **Toast** عابر (٢.٢ ثانية) للحفظ/الخطأ + نافذة undo مميزة (٥ ثوانٍ مع عدّاد).

---

## ١٨. أمان وصلاحية المعرّفات

### `buildItemId(fromSurah, fromAyah, toSurah, toAyah)`

```js
return `${fromSurah}:${fromAyah}-${toSurah}:${toAyah}`;
// مثال: "2:255-2:255"  →  آية الكرسي
```

**الفوائد:**
- **Deduplication**: محاولة حفظ نفس النطاق مرتين → لا ينشأ عنصر جديد، فقط يُحرَّك المؤشر.
- **Backup validation**: يجب أن يطابق المعرّف المشتق من النطاق بالضبط (رفض أي تلاعب).

### التحقق من المواضع (`validatePosition`)

يرفض:
- رقم سورة < 1 أو > 114.
- رقم آية < 1 أو > عدد آيات السورة.
- قيم غير صحيحة (NaN, undefined, null).

---

## ١٩. اختبار النظام

- اختبارات العقدة موجودة في `project-helper/test-memorization-core.js` و `project-helper/test-memorization-storage.js`.
- اختبارات الـ UI يدوية بفتح `index.html` في Chrome / Firefox / Edge.
- يجب اجتياز معايير القبول الـ ١٧ في القسم ٢١ من `progress_plan.md`.

---

## ٢٠. ملخص التدفق الكامل (End-to-End)

```
[المستخدم يفتح #memorization]
        │
        ▼
[app.js] MemorizationView.render()
        │
        ▼
[init] IndexedDbAdapter.loadState() ──► إن فشل → state جديد
        │
        ▼
[Engine] ensureCurrentDay(state)    ──► لو اليوم تغيّر → تصفير حقول اليوم
        │
        ▼
[Engine] getDailyTaskSummary(state)
        │
        ▼
[Engine] getStatistics(state)
        │
        ▼
[UI] رسم ٨ بطاقات HTML
        │
        ▼
[المستخدم] يضغط "تم الحفظ"
        │
        ▼
[Engine] completeNewMemorization(state)
        │   ├─ لقطة undo
        │   ├─ حساب النطاق
        │   ├─ إنشاء/جلب العنصر
        │   ├─ تقدّم المؤشر
        │   └─ محاولة تحديث السلسلة
        │
        ▼
[Storage] saveState(state)          ──► نجاح: toast، فشل: toast خطأ + undo
        │
        ▼
[Sync] localStorage.setItem + dispatchEvent
        │
        ▼
[UI] render()                       ──► إعادة الرسم
        │
        ▼
[المستخدم] يقيّم مراجعة → showUndoToast(5s)
        │
        ▼
[Engine] reviewItem(state, id, rating)
        │   ├─ لقطة undo
        │   ├─ تحديث interval/easeFactor/status
        │   ├─ حساب nextReview
        │   └─ محاولة تحديث السلسلة
        │
        ▼
[Storage] saveState(state)
        │
        ▼
[Sync] إشارات المزامنة
        │
        ▼
[UI] render() + عرض Toast التراجع
        │
        ▼
[المستخدم] يضغط "تراجع" قبل ٥ ثوانٍ؟
        │
       نعم ─► [Engine] undoLastReview(state) ─► [Storage] saveState
        │
        ▼
[النتيجة] الحالة السابقة تماماً
```

---

## ٢١. نقاط قوة النظام

| الميزة | الفائدة |
|:---|:---|
| **Idempotency** في كل العمليات | آمن من الضغطات المكررة |
| **Snapshot قبل كل تعديل** | تراجع فوري موثوق |
| **Deterministic IDs** | استيراد/تصدير متطابق، لا تكرار |
| **Local Calendar Dates** | لا أخطاء منتصف الليل |
| **حد مراجعة يومي** | لا إرهاق بعد غياب طويل |
| **شرط مزدوج للإتقان** | لا إتقان مبكر مُضلل |
| **فصل المنطق عن العرض** | اختبار وصيانة أسهل |
| **تحقق صارم في النسخ** | لا يمكن استيراد بيانات فاسدة |
| **مزامنة بين التبويبات** | تجربة سلسة عبر الأجهزة |

---

## ٢٢. ثوابت التكوين

| الثابت | القيمة | الموقع |
|:---|:---|:---|
| `SCHEMA_VERSION` | 3 | `memorizationEngine.js` |
| `DAILY_REVIEW_LIMIT` (fallback ثابت) | 10 | `memorizationView.js` |
| **حد المراجعة اليومي الفعلي** | `3 × plan.dailyAmount` | `MemorizationEngine.dailyReviewCap` |
| `UNDO_WINDOW_MS` | 5000 (ms) | `memorizationView.js` |
| `EASE_MIN` / `EASE_MAX` | 1.3 / 3.0 | `memorizationEngine.js`, `backupValidator.js` |
| `DB_NAME` / `DB_VERSION` | `quran_memorization_db` / 1 | `indexedDbAdapter.js` |
| `STORE_NAME` | `state` | `indexedDbAdapter.js` |
| `SAFETY_CAP` (آيات) | 6236 | `memorizationEngine.js` |
| Toast success (ms) | 2200 | `memorizationView.js` |

---

> **ملاحظة:** هذا التقرير يصف التنفيذ الفعلي في الكود الحالي. أي تعديلات مستقبلية يجب أن تحافظ على العقود العامة (V3 schema، idempotency، فصل المنطق عن العرض).
