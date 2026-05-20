// Trial-ending reminder — admin-triggered. Sent 1 day before the company's
// trial expires. {name} = restaurant title (or email local-part). Tone:
// helpful heads-up, not pushy.

interface T {
  subject: string;
  greeting: string;
  body: string;
  help: string;
  closing: string;
  signature: string;
}

const DASHBOARD_URL = "dashboard.iq-rest.com";
const BILLING_PATH = "/settings/billing";

export const TRIAL_ENDING: Record<string, T> = {
  ar: {
    subject: "تجربتك في IQ Rest تنتهي غدًا",
    greeting: "مرحبًا {name}،",
    body: "تذكير سريع: تجربتك المجانية في IQ Rest تنتهي غدًا. بعد ذلك، لن تكون قائمة QR متاحة لضيوفك حتى تختار خطة.",
    help: `يمكنك اختيار خطة في دقيقتين من لوحة التحكم — تبدأ الخطة الأساسية من €6.90 شهريًا: ${DASHBOARD_URL}${BILLING_PATH}. إذا كان لديك أي سؤال، فقط رد على هذا البريد.`,
    closing: "شكرًا لتجربتك IQ Rest.",
    signature: "مع أطيب التحيات،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  bg: {
    subject: "Пробният период на IQ Rest изтича утре",
    greeting: "Здравей {name},",
    body: "Малко напомняне: безплатният ти пробен период в IQ Rest изтича утре. След това QR менюто ти няма да е достъпно за гостите, докато не избереш план.",
    help: `Можеш да избереш план за 2 минути от панела — Basic започва от €6.90/мес: ${DASHBOARD_URL}${BILLING_PATH}. Ако имаш въпроси, просто отговори на този имейл.`,
    closing: "Благодаря, че опита IQ Rest.",
    signature: "С уважение,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  ca: {
    subject: "La teva prova d'IQ Rest acaba demà",
    greeting: "Hola {name},",
    body: "Petit recordatori: la teva prova gratuïta d'IQ Rest acaba demà. Després, el menú QR no estarà disponible per als clients fins que triïs un pla.",
    help: `Pots triar un pla en 2 minuts des del panell — Basic des de €6,90/mes: ${DASHBOARD_URL}${BILLING_PATH}. Si tens cap pregunta, només respon a aquest correu.`,
    closing: "Gràcies per provar IQ Rest.",
    signature: "Salutacions,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  cs: {
    subject: "Vaše zkušební verze IQ Rest končí zítra",
    greeting: "Ahoj {name},",
    body: "Krátká připomínka: vaše bezplatná zkušební verze IQ Rest končí zítra. Poté nebude QR menu dostupné pro vaše hosty, dokud nezvolíte tarif.",
    help: `Tarif zvolíte za 2 minuty v panelu — Basic od €6,90/měs: ${DASHBOARD_URL}${BILLING_PATH}. Pokud máte otázku, stačí odpovědět na tento e-mail.`,
    closing: "Děkuji, že jste IQ Rest vyzkoušeli.",
    signature: "S pozdravem,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  da: {
    subject: "Din IQ Rest-prøveperiode slutter i morgen",
    greeting: "Hej {name},",
    body: "Lille reminder: din gratis prøveperiode i IQ Rest slutter i morgen. Derefter vil QR-menuen ikke være tilgængelig for dine gæster, før du vælger en plan.",
    help: `Du kan vælge en plan på 2 minutter i panelet — Basic fra €6,90/md: ${DASHBOARD_URL}${BILLING_PATH}. Har du spørgsmål, svar bare på denne e-mail.`,
    closing: "Tak fordi du prøvede IQ Rest.",
    signature: "Venlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  de: {
    subject: "Deine IQ Rest-Testphase endet morgen",
    greeting: "Hallo {name},",
    body: "Kurze Erinnerung: Deine kostenlose Testphase bei IQ Rest endet morgen. Danach ist dein QR-Menü für deine Gäste nicht mehr verfügbar, bis du einen Tarif wählst.",
    help: `Wähle in 2 Minuten einen Tarif im Dashboard — Basic ab €6,90/Mon: ${DASHBOARD_URL}${BILLING_PATH}. Bei Fragen einfach auf diese E-Mail antworten.`,
    closing: "Danke, dass du IQ Rest ausprobiert hast.",
    signature: "Beste Grüße,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  el: {
    subject: "Η δοκιμαστική περίοδος του IQ Rest λήγει αύριο",
    greeting: "Γεια σου {name},",
    body: "Σύντομη υπενθύμιση: η δωρεάν δοκιμαστική περίοδος στο IQ Rest λήγει αύριο. Στη συνέχεια, το QR μενού σου δεν θα είναι διαθέσιμο στους πελάτες μέχρι να επιλέξεις πακέτο.",
    help: `Διάλεξε πακέτο σε 2 λεπτά από τον πίνακα — Basic από €6,90/μήνα: ${DASHBOARD_URL}${BILLING_PATH}. Αν έχεις απορίες, απλώς απάντησε σε αυτό το email.`,
    closing: "Ευχαριστώ που δοκίμασες το IQ Rest.",
    signature: "Με εκτίμηση,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  en: {
    subject: "Your IQ Rest trial ends tomorrow",
    greeting: "Hi {name},",
    body: "Quick heads-up: your IQ Rest free trial ends tomorrow. After that, your QR menu won't be available to your guests until you pick a plan.",
    help: `You can pick a plan in 2 minutes from the dashboard — Basic starts at €6.90/mo: ${DASHBOARD_URL}${BILLING_PATH}. If you have any questions, just reply to this email.`,
    closing: "Thanks for trying IQ Rest.",
    signature: "Best regards,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  es: {
    subject: "Tu prueba de IQ Rest termina mañana",
    greeting: "Hola {name},",
    body: "Recordatorio rápido: tu prueba gratuita de IQ Rest termina mañana. Después, tu menú QR no estará disponible para tus clientes hasta que elijas un plan.",
    help: `Puedes elegir un plan en 2 minutos desde el panel — Basic desde €6,90/mes: ${DASHBOARD_URL}${BILLING_PATH}. Si tienes alguna pregunta, solo responde a este correo.`,
    closing: "Gracias por probar IQ Rest.",
    signature: "Saludos,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  et: {
    subject: "Sinu IQ Rest prooviperiood lõpeb homme",
    greeting: "Tere {name},",
    body: "Lühike meeldetuletus: sinu tasuta prooviperiood IQ Restis lõpeb homme. Pärast seda ei ole QR-menüü külalistele saadaval, kuni valid paketi.",
    help: `Saad paketi valida 2 minutiga paneelist — Basic alates €6,90/kuus: ${DASHBOARD_URL}${BILLING_PATH}. Kui sul on küsimusi, lihtsalt vasta sellele e-kirjale.`,
    closing: "Aitäh, et proovisid IQ Resti.",
    signature: "Lugupidamisega,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fa: {
    subject: "دوره آزمایشی IQ Rest شما فردا تمام می‌شود",
    greeting: "سلام {name}،",
    body: "یادآوری سریع: دوره آزمایشی رایگان شما در IQ Rest فردا به پایان می‌رسد. پس از آن، منوی QR شما تا انتخاب یک پلن برای مهمانان در دسترس نخواهد بود.",
    help: `می‌توانید در ۲ دقیقه از پنل یک پلن انتخاب کنید — Basic از €6.90 در ماه: ${DASHBOARD_URL}${BILLING_PATH}. اگر سوالی دارید، کافی است به این ایمیل پاسخ دهید.`,
    closing: "ممنون که IQ Rest را امتحان کردید.",
    signature: "با احترام،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fi: {
    subject: "IQ Rest -kokeilujaksosi päättyy huomenna",
    greeting: "Hei {name},",
    body: "Pieni muistutus: ilmainen IQ Rest -kokeilujaksosi päättyy huomenna. Sen jälkeen QR-ruokalistasi ei ole vieraidesi saatavilla, ennen kuin valitset paketin.",
    help: `Voit valita paketin 2 minuutissa paneelista — Basic alkaen 6,90 €/kk: ${DASHBOARD_URL}${BILLING_PATH}. Jos sinulla on kysyttävää, vastaa vain tähän sähköpostiin.`,
    closing: "Kiitos, että kokeilit IQ Restia.",
    signature: "Ystävällisin terveisin,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fr: {
    subject: "Votre essai IQ Rest se termine demain",
    greeting: "Bonjour {name},",
    body: "Petit rappel : votre essai gratuit d'IQ Rest se termine demain. Après cela, votre menu QR ne sera plus accessible à vos clients tant que vous n'aurez pas choisi un forfait.",
    help: `Vous pouvez choisir un forfait en 2 minutes depuis le panneau — Basic à partir de 6,90 €/mois : ${DASHBOARD_URL}${BILLING_PATH}. Pour toute question, répondez simplement à cet e-mail.`,
    closing: "Merci d'avoir essayé IQ Rest.",
    signature: "Cordialement,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ga: {
    subject: "Críochnóidh do thriail IQ Rest amárach",
    greeting: "A {name},",
    body: "Meabhrúchán tapa: críochnóidh do thriail saor in aisce IQ Rest amárach. Ina dhiaidh sin, ní bheidh do roghchlár QR ar fáil do d'aíonna go dtí go roghnóidh tú plean.",
    help: `Is féidir leat plean a roghnú i 2 nóiméad ón bpainéal — Basic ó €6.90/mí: ${DASHBOARD_URL}${BILLING_PATH}. Má tá ceist agat, freagair an ríomhphost seo.`,
    closing: "Go raibh maith agat as triail a bhaint as IQ Rest.",
    signature: "Le meas,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hr: {
    subject: "Tvoje IQ Rest probno razdoblje istječe sutra",
    greeting: "Bok {name},",
    body: "Brzi podsjetnik: tvoje besplatno probno razdoblje u IQ Restu istječe sutra. Nakon toga QR jelovnik neće biti dostupan gostima dok ne odabereš plan.",
    help: `Plan možeš odabrati u 2 minute iz panela — Basic od €6,90/mj: ${DASHBOARD_URL}${BILLING_PATH}. Ako imaš pitanja, samo odgovori na ovaj email.`,
    closing: "Hvala što si isprobao/la IQ Rest.",
    signature: "Pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hu: {
    subject: "Az IQ Rest próbaidőszakod holnap lejár",
    greeting: "Szia {name},",
    body: "Gyors emlékeztető: az IQ Rest ingyenes próbaidőszakod holnap lejár. Ezután a QR menü nem lesz elérhető a vendégeid számára, amíg nem választasz csomagot.",
    help: `2 perc alatt választhatsz csomagot a panelen — a Basic 6,90 €/hó-tól: ${DASHBOARD_URL}${BILLING_PATH}. Ha kérdésed van, csak válaszolj erre az e-mailre.`,
    closing: "Köszönöm, hogy kipróbáltad az IQ Restet.",
    signature: "Üdvözlettel,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  is: {
    subject: "IQ Rest prufutímabilið þitt rennur út á morgun",
    greeting: "Halló {name},",
    body: "Stutt áminning: ókeypis prufutímabilið þitt í IQ Rest rennur út á morgun. Eftir það verður QR matseðillinn ekki tiltækur fyrir gesti þína fyrr en þú velur áskrift.",
    help: `Þú getur valið áskrift á 2 mínútum úr stjórnborðinu — Basic frá €6,90/mán: ${DASHBOARD_URL}${BILLING_PATH}. Ef þú hefur spurningar, svaraðu bara þessum tölvupósti.`,
    closing: "Takk fyrir að prófa IQ Rest.",
    signature: "Bestu kveðjur,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  it: {
    subject: "La tua prova di IQ Rest finisce domani",
    greeting: "Ciao {name},",
    body: "Promemoria veloce: la tua prova gratuita di IQ Rest finisce domani. Dopo, il menu QR non sarà più disponibile per i tuoi clienti finché non scegli un piano.",
    help: `Puoi scegliere un piano in 2 minuti dal pannello — Basic da €6,90/mese: ${DASHBOARD_URL}${BILLING_PATH}. Se hai domande, basta rispondere a questa email.`,
    closing: "Grazie per aver provato IQ Rest.",
    signature: "Cordiali saluti,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ja: {
    subject: "IQ Rest の無料トライアルが明日終了します",
    greeting: "{name} 様、",
    body: "簡単なお知らせです：IQ Rest の無料トライアルが明日終了します。その後はプランを選ぶまで、QR メニューはお客様にご覧いただけなくなります。",
    help: `ダッシュボードから 2 分でプランを選べます — Basic は月額 €6.90 から：${DASHBOARD_URL}${BILLING_PATH}。ご質問があれば、このメールに返信してください。`,
    closing: "IQ Rest をお試しいただきありがとうございます。",
    signature: "よろしくお願いいたします、<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ko: {
    subject: "IQ Rest 무료 체험이 내일 종료됩니다",
    greeting: "{name}님,",
    body: "간단한 알림입니다: IQ Rest 무료 체험이 내일 종료됩니다. 이후에는 요금제를 선택하기 전까지 QR 메뉴를 손님들에게 제공할 수 없습니다.",
    help: `대시보드에서 2분 만에 요금제를 선택할 수 있습니다 — Basic은 월 €6.90부터: ${DASHBOARD_URL}${BILLING_PATH}. 궁금한 점은 이 이메일에 회신해 주세요.`,
    closing: "IQ Rest를 사용해 보셔서 감사합니다.",
    signature: "감사합니다,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lt: {
    subject: "Jūsų IQ Rest bandomasis laikotarpis baigiasi rytoj",
    greeting: "Sveiki, {name},",
    body: "Trumpas priminimas: nemokamas IQ Rest bandomasis laikotarpis baigiasi rytoj. Po to QR meniu nebus prieinamas svečiams, kol nepasirinksite plano.",
    help: `Planą galite pasirinkti per 2 minutes iš panelės — Basic nuo €6,90/mėn: ${DASHBOARD_URL}${BILLING_PATH}. Jei turite klausimų, tiesiog atsakykite į šį laišką.`,
    closing: "Ačiū, kad išbandėte IQ Rest.",
    signature: "Pagarbiai,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lv: {
    subject: "Jūsu IQ Rest izmēģinājuma periods beidzas rīt",
    greeting: "Sveiki, {name},",
    body: "Īss atgādinājums: jūsu bezmaksas IQ Rest izmēģinājuma periods beidzas rīt. Pēc tam QR ēdienkarte nebūs pieejama viesiem, kamēr neizvēlēsieties plānu.",
    help: `Plānu varat izvēlēties 2 minūtēs no paneļa — Basic no €6,90/mēn: ${DASHBOARD_URL}${BILLING_PATH}. Ja ir jautājumi, vienkārši atbildiet uz šo e-pastu.`,
    closing: "Paldies, ka izmēģinājāt IQ Rest.",
    signature: "Ar cieņu,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  nl: {
    subject: "Je IQ Rest-proefperiode eindigt morgen",
    greeting: "Hoi {name},",
    body: "Korte herinnering: je gratis IQ Rest-proefperiode eindigt morgen. Daarna is je QR-menu niet meer beschikbaar voor je gasten totdat je een abonnement kiest.",
    help: `Je kunt in 2 minuten een abonnement kiezen vanuit het paneel — Basic vanaf €6,90/mnd: ${DASHBOARD_URL}${BILLING_PATH}. Heb je vragen, beantwoord gewoon deze e-mail.`,
    closing: "Bedankt dat je IQ Rest hebt geprobeerd.",
    signature: "Met vriendelijke groet,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  no: {
    subject: "Din IQ Rest-prøveperiode slutter i morgen",
    greeting: "Hei {name},",
    body: "Liten påminnelse: din gratis prøveperiode i IQ Rest slutter i morgen. Etter det vil ikke QR-menyen være tilgjengelig for gjestene før du velger en plan.",
    help: `Du kan velge en plan på 2 minutter fra panelet — Basic fra €6,90/mnd: ${DASHBOARD_URL}${BILLING_PATH}. Har du spørsmål, svar gjerne på denne e-posten.`,
    closing: "Takk for at du prøvde IQ Rest.",
    signature: "Vennlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pl: {
    subject: "Twój okres próbny IQ Rest kończy się jutro",
    greeting: "Cześć {name},",
    body: "Szybkie przypomnienie: Twój darmowy okres próbny w IQ Rest kończy się jutro. Potem menu QR nie będzie dostępne dla gości, dopóki nie wybierzesz planu.",
    help: `Plan możesz wybrać w 2 minuty z panelu — Basic od €6,90/mies: ${DASHBOARD_URL}${BILLING_PATH}. Jeśli masz pytania, po prostu odpowiedz na ten e-mail.`,
    closing: "Dziękuję za wypróbowanie IQ Rest.",
    signature: "Pozdrawiam,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pt: {
    subject: "A tua experiência IQ Rest termina amanhã",
    greeting: "Olá {name},",
    body: "Um lembrete rápido: a tua experiência gratuita no IQ Rest termina amanhã. Depois disso, o menu QR não estará disponível para os clientes até escolheres um plano.",
    help: `Podes escolher um plano em 2 minutos a partir do painel — Basic desde €6,90/mês: ${DASHBOARD_URL}${BILLING_PATH}. Se tiveres dúvidas, basta responder a este email.`,
    closing: "Obrigado por experimentares o IQ Rest.",
    signature: "Cumprimentos,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ro: {
    subject: "Perioada de probă IQ Rest se încheie mâine",
    greeting: "Salut {name},",
    body: "Un reminder rapid: perioada gratuită de probă IQ Rest se încheie mâine. După aceea, meniul QR nu va fi disponibil pentru clienți până când alegi un plan.",
    help: `Poți alege un plan în 2 minute din panou — Basic de la €6,90/lună: ${DASHBOARD_URL}${BILLING_PATH}. Dacă ai întrebări, răspunde la acest e-mail.`,
    closing: "Mulțumesc că ai încercat IQ Rest.",
    signature: "Cu stimă,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ru: {
    subject: "Пробный период IQ Rest заканчивается завтра",
    greeting: "Здравствуйте, {name}!",
    body: "Небольшое напоминание: ваш бесплатный пробный период в IQ Rest заканчивается завтра. После этого QR-меню будет недоступно гостям, пока вы не выберете тариф.",
    help: `Выбрать тариф можно за 2 минуты в кабинете — Basic от €6,90/мес: ${DASHBOARD_URL}${BILLING_PATH}. Если есть вопросы, просто ответьте на это письмо.`,
    closing: "Спасибо, что попробовали IQ Rest.",
    signature: "С уважением,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sk: {
    subject: "Vaša skúšobná verzia IQ Rest končí zajtra",
    greeting: "Ahoj {name},",
    body: "Krátka pripomienka: vaša bezplatná skúšobná verzia IQ Rest končí zajtra. Potom nebude QR menu dostupné hosťom, kým nezvolíte plán.",
    help: `Plán si môžete vybrať za 2 minúty v paneli — Basic od €6,90/mes: ${DASHBOARD_URL}${BILLING_PATH}. Ak máte otázku, stačí odpovedať na tento e-mail.`,
    closing: "Ďakujem, že ste si vyskúšali IQ Rest.",
    signature: "S pozdravom,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sl: {
    subject: "Tvoje preizkusno obdobje IQ Rest se konča jutri",
    greeting: "Pozdravljen/a {name},",
    body: "Hiter opomnik: tvoje brezplačno preizkusno obdobje v IQ Rest se konča jutri. Nato QR meni gostom ne bo več na voljo, dokler ne izbereš naročnine.",
    help: `Naročnino lahko izbereš v 2 minutah iz panela — Basic od €6,90/mes: ${DASHBOARD_URL}${BILLING_PATH}. Če imaš vprašanja, samo odgovori na to e-pošto.`,
    closing: "Hvala, da si preizkusil/a IQ Rest.",
    signature: "Lep pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sr: {
    subject: "Твој IQ Rest пробни период истиче сутра",
    greeting: "Здраво {name},",
    body: "Кратак подсетник: твој бесплатни пробни период у IQ Rest-у истиче сутра. После тога QR мени неће бити доступан гостима док не одабереш план.",
    help: `План можеш одабрати за 2 минута из панела — Basic од €6,90/мес: ${DASHBOARD_URL}${BILLING_PATH}. Ако имаш питања, само одговори на овај имејл.`,
    closing: "Хвала што си пробао/ла IQ Rest.",
    signature: "Поздрав,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sv: {
    subject: "Din IQ Rest-provperiod tar slut imorgon",
    greeting: "Hej {name},",
    body: "Liten påminnelse: din gratis provperiod i IQ Rest tar slut imorgon. Därefter är QR-menyn inte tillgänglig för dina gäster förrän du väljer en plan.",
    help: `Du kan välja en plan på 2 minuter från panelen — Basic från €6,90/mån: ${DASHBOARD_URL}${BILLING_PATH}. Har du frågor, svara bara på det här mejlet.`,
    closing: "Tack för att du provade IQ Rest.",
    signature: "Vänliga hälsningar,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  tr: {
    subject: "IQ Rest deneme süreniz yarın sona eriyor",
    greeting: "Merhaba {name},",
    body: "Kısa bir hatırlatma: IQ Rest ücretsiz deneme süreniz yarın sona eriyor. Sonrasında bir plan seçene kadar QR menünüz misafirleriniz için kullanılamayacak.",
    help: `Panelden 2 dakikada bir plan seçebilirsiniz — Basic €6,90/ay'dan başlıyor: ${DASHBOARD_URL}${BILLING_PATH}. Sorunuz varsa bu e-postayı yanıtlamanız yeterli.`,
    closing: "IQ Rest'i denediğiniz için teşekkürler.",
    signature: "Saygılarımla,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  uk: {
    subject: "Пробний період IQ Rest завершується завтра",
    greeting: "Вітаю, {name},",
    body: "Невелике нагадування: ваш безкоштовний пробний період в IQ Rest завершується завтра. Після цього QR-меню буде недоступне гостям, поки ви не оберете тариф.",
    help: `Обрати тариф можна за 2 хвилини в кабінеті — Basic від €6,90/міс: ${DASHBOARD_URL}${BILLING_PATH}. Якщо є питання, просто дайте відповідь на цей лист.`,
    closing: "Дякую, що спробували IQ Rest.",
    signature: "З повагою,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  zh: {
    subject: "您的 IQ Rest 免费试用明天到期",
    greeting: "{name}，您好，",
    body: "简短提醒：您在 IQ Rest 的免费试用明天到期。之后，您的 QR 菜单将无法向客人展示，直到您选择一个套餐。",
    help: `您可以在控制台 2 分钟内选择套餐 — Basic 每月 €6.90 起：${DASHBOARD_URL}${BILLING_PATH}。如果有任何问题,只需回复这封邮件即可。`,
    closing: "感谢您试用 IQ Rest。",
    signature: "此致,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
};

const RTL = new Set(["ar", "fa"]);
export function isRtl(locale: string): boolean {
  return RTL.has(locale);
}

export function pickTrialEnding(locale: string): T {
  return TRIAL_ENDING[locale] || TRIAL_ENDING.en;
}
