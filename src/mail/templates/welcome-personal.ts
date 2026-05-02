// Personal welcome email — sent manually from the admin panel to introduce
// Bogdan to a new restaurant owner. {name} is replaced with the restaurant
// title (or the email local-part as fallback).
//
// Translations restored from soqrmenuweb commit 60dc8a6 (2026-02-28).

interface T {
  subject: string;
  greeting: string;
  body: string;
  help: string;
  closing: string;
  signature: string;
}

export const WELCOME_PERSONAL: Record<string, T> = {
  ar: {
    subject: "مرحبًا بك في IQ Rest، {name}!",
    greeting: "مرحبًا {name}،",
    body: "أنا Bogdan، وسأتولى إدارة حسابك في IQ Rest.",
    help: "إذا كانت لديك أي أسئلة حول إعداد قائمة QR أو الموقع أو الحجوزات أو أي شيء آخر — فقط قم بالرد على هذا البريد الإلكتروني. أنا هنا للمساعدة.",
    closing: "أتطلع للعمل معك!",
    signature: "مع أطيب التحيات،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  bg: {
    subject: "Добре дошли в IQ Rest, {name}!",
    greeting: "Здравей {name},",
    body: "Аз съм Богдан и ще се грижа за акаунта ви в IQ Rest.",
    help: "Ако имате въпроси относно настройката на QR менюто, уебсайта, резервациите или нещо друго — просто отговорете на този имейл. Тук съм, за да помогна.",
    closing: "Очаквам с нетърпение съвместната ни работа!",
    signature: "С уважение,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  ca: {
    subject: "Benvingut a IQ Rest, {name}!",
    greeting: "Hola {name},",
    body: "Sóc en Bogdan i m'encarregaré del teu compte a IQ Rest.",
    help: "Si tens preguntes sobre la configuració del menú QR, lloc web, reserves o qualsevol altra cosa — simplement respon a aquest correu. Sóc aquí per ajudar-te.",
    closing: "Espero treballar amb tu!",
    signature: "Salutacions,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  cs: {
    subject: "Vítejte v IQ Rest, {name}!",
    greeting: "Ahoj {name},",
    body: "Jsem Bogdan a budu se starat o váš účet v IQ Rest.",
    help: "Pokud máte dotazy ohledně nastavení QR menu, webu, rezervací nebo čehokoli jiného — stačí odpovědět na tento e-mail. Jsem tu, abych pomohl.",
    closing: "Těším se na spolupráci!",
    signature: "S pozdravem,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  da: {
    subject: "Velkommen til IQ Rest, {name}!",
    greeting: "Hej {name},",
    body: "Jeg hedder Bogdan, og jeg vil tage mig af din konto hos IQ Rest.",
    help: "Hvis du har spørgsmål om opsætning af din QR-menu, hjemmeside, reservationer eller andet — svar blot på denne e-mail. Jeg er her for at hjælpe.",
    closing: "Glæder mig til at arbejde sammen med dig!",
    signature: "Venlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  de: {
    subject: "Willkommen bei IQ Rest, {name}!",
    greeting: "Hallo {name},",
    body: "Ich bin Bogdan und werde mich um Ihr Konto bei IQ Rest kümmern.",
    help: "Wenn Sie Fragen zur Einrichtung Ihres QR-Menüs, Ihrer Website, Reservierungen oder anderem haben — antworten Sie einfach auf diese E-Mail. Ich bin hier, um zu helfen.",
    closing: "Ich freue mich auf die Zusammenarbeit!",
    signature: "Beste Grüße,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  el: {
    subject: "Καλώς ήρθατε στο IQ Rest, {name}!",
    greeting: "Γεια σου {name},",
    body: "Είμαι ο Bogdan και θα φροντίζω τον λογαριασμό σου στο IQ Rest.",
    help: "Αν έχεις ερωτήσεις σχετικά με τη ρύθμιση του QR μενού, της ιστοσελίδας, των κρατήσεων ή οτιδήποτε άλλο — απλά απάντησε σε αυτό το email. Είμαι εδώ για να βοηθήσω.",
    closing: "Ανυπομονώ να συνεργαστούμε!",
    signature: "Με εκτίμηση,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  en: {
    subject: "Welcome to IQ Rest, {name}!",
    greeting: "Hi {name},",
    body: "I'm Bogdan, and I'll be looking after your account at IQ Rest.",
    help: "If you have any questions about setting up your QR menu, website, bookings, or anything else — just reply to this email. I'm here to help.",
    closing: "Looking forward to working with you!",
    signature: "Best,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  es: {
    subject: "¡Bienvenido a IQ Rest, {name}!",
    greeting: "Hola {name},",
    body: "Soy Bogdan y me encargaré de tu cuenta en IQ Rest.",
    help: "Si tienes alguna pregunta sobre la configuración de tu menú QR, sitio web, reservas o cualquier otra cosa — solo responde a este correo. Estoy aquí para ayudarte.",
    closing: "¡Espero trabajar contigo!",
    signature: "Saludos,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  et: {
    subject: "Tere tulemast IQ Resti, {name}!",
    greeting: "Tere {name},",
    body: "Olen Bogdan ja hoolitsen teie konto eest IQ Restis.",
    help: "Kui teil on küsimusi QR-menüü, veebisaidi, broneeringute või millegi muu seadistamise kohta — vastake lihtsalt sellele e-kirjale. Olen siin, et aidata.",
    closing: "Ootan koostööd!",
    signature: "Parimate soovidega,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fa: {
    subject: "به IQ Rest خوش آمدید، {name}!",
    greeting: "سلام {name}،",
    body: "من Bogdan هستم و حساب شما را در IQ Rest مدیریت خواهم کرد.",
    help: "اگر سؤالی درباره تنظیم منوی QR، وب‌سایت، رزرو یا هر چیز دیگری دارید — فقط به این ایمیل پاسخ دهید. من اینجا هستم تا کمک کنم.",
    closing: "مشتاق همکاری با شما هستم!",
    signature: "با احترام،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fi: {
    subject: "Tervetuloa IQ Restiin, {name}!",
    greeting: "Hei {name},",
    body: "Olen Bogdan ja hoidan tiliäsi IQ Restissä.",
    help: "Jos sinulla on kysyttävää QR-menun, verkkosivuston, varausten tai minkä tahansa muun asetuksen suhteen — vastaa tähän sähköpostiin. Olen täällä auttamassa.",
    closing: "Odotan innolla yhteistyötä!",
    signature: "Ystävällisin terveisin,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fr: {
    subject: "Bienvenue sur IQ Rest, {name} !",
    greeting: "Bonjour {name},",
    body: "Je suis Bogdan et je m'occuperai de votre compte chez IQ Rest.",
    help: "Si vous avez des questions sur la configuration de votre menu QR, site web, réservations ou autre — répondez simplement à cet e-mail. Je suis là pour vous aider.",
    closing: "Au plaisir de travailler avec vous !",
    signature: "Cordialement,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ga: {
    subject: "Fáilte go IQ Rest, {name}!",
    greeting: "Dia duit {name},",
    body: "Is mise Bogdan, agus beidh mé ag tabhairt aire do do chuntas ag IQ Rest.",
    help: "Má tá aon cheist agat faoi do roghchlár QR, suíomh gréasáin, áirithintí nó aon rud eile a shocrú — freagair an ríomhphost seo. Tá mé anseo chun cabhrú.",
    closing: "Ag tnúth le bheith ag obair leat!",
    signature: "Le meas,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hr: {
    subject: "Dobrodošli u IQ Rest, {name}!",
    greeting: "Bok {name},",
    body: "Ja sam Bogdan i brinut ću o vašem računu na IQ Rest.",
    help: "Ako imate pitanja o postavljanju QR izbornika, web stranice, rezervacija ili bilo čega drugog — jednostavno odgovorite na ovaj email. Tu sam da pomognem.",
    closing: "Veselim se suradnji!",
    signature: "Srdačan pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hu: {
    subject: "Üdvözöljük az IQ Restnél, {name}!",
    greeting: "Szia {name}!",
    body: "Bogdan vagyok, és én fogom kezelni a fiókodat az IQ Restnél.",
    help: "Ha kérdésed van a QR menü, weboldal, foglalások beállításáról vagy bármi másról — egyszerűen válaszolj erre az e-mailre. Itt vagyok, hogy segítsek.",
    closing: "Alig várom a közös munkát!",
    signature: "Üdvözlettel,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  is: {
    subject: "Velkomin í IQ Rest, {name}!",
    greeting: "Hæ {name},",
    body: "Ég heiti Bogdan og mun sjá um reikninginn þinn hjá IQ Rest.",
    help: "Ef þú hefur einhverjar spurningar um uppsetningu QR matseðils, vefsíðu, bókanir eða eitthvað annað — svaraðu bara þessum tölvupósti. Ég er hér til að hjálpa.",
    closing: "Hlakka til að vinna með þér!",
    signature: "Kveðja,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  it: {
    subject: "Benvenuto su IQ Rest, {name}!",
    greeting: "Ciao {name},",
    body: "Sono Bogdan e mi occuperò del tuo account su IQ Rest.",
    help: "Se hai domande sulla configurazione del tuo menu QR, sito web, prenotazioni o altro — rispondi semplicemente a questa email. Sono qui per aiutarti.",
    closing: "Non vedo l'ora di lavorare con te!",
    signature: "Cordiali saluti,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ja: {
    subject: "IQ Restへようこそ、{name}さん！",
    greeting: "{name}さん、こんにちは。",
    body: "IQ Restでお客様のアカウントを担当するBogdanです。",
    help: "QRメニュー、ウェブサイト、予約など、設定についてご質問がございましたら、このメールにご返信ください。お手伝いいたします。",
    closing: "お客様と一緒にお仕事できることを楽しみにしています！",
    signature: "よろしくお願いいたします。<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ko: {
    subject: "IQ Rest에 오신 것을 환영합니다, {name}님!",
    greeting: "{name}님, 안녕하세요.",
    body: "저는 Bogdan이며, IQ Rest에서 귀하의 계정을 관리하게 되었습니다.",
    help: "QR 메뉴, 웹사이트, 예약 등 설정에 관한 질문이 있으시면 이 이메일에 답장해 주세요. 도와드리겠습니다.",
    closing: "함께 일하게 되어 기대됩니다!",
    signature: "감사합니다,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lt: {
    subject: "Sveiki atvykę į IQ Rest, {name}!",
    greeting: "Sveiki {name},",
    body: "Esu Bogdan ir rūpinsiuosi jūsų paskyra IQ Rest.",
    help: "Jei turite klausimų apie QR meniu, svetainės, rezervacijų ar bet ko kito nustatymą — tiesiog atsakykite į šį el. laišką. Esu čia, kad padėčiau.",
    closing: "Laukiu bendradarbiavimo!",
    signature: "Pagarbiai,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lv: {
    subject: "Laipni lūdzam IQ Rest, {name}!",
    greeting: "Sveiki {name},",
    body: "Es esmu Bogdans, un es rūpēšos par jūsu kontu IQ Rest.",
    help: "Ja jums ir jautājumi par QR ēdienkartes, tīmekļa vietnes, rezervāciju vai citu iestatīšanu — vienkārši atbildiet uz šo e-pastu. Es esmu šeit, lai palīdzētu.",
    closing: "Ar nepacietību gaidu sadarbību!",
    signature: "Ar cieņu,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  nl: {
    subject: "Welkom bij IQ Rest, {name}!",
    greeting: "Hallo {name},",
    body: "Ik ben Bogdan en ik zal voor je account bij IQ Rest zorgen.",
    help: "Als je vragen hebt over het instellen van je QR-menu, website, reserveringen of iets anders — beantwoord deze e-mail gewoon. Ik ben hier om te helpen.",
    closing: "Ik kijk uit naar onze samenwerking!",
    signature: "Met vriendelijke groet,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  no: {
    subject: "Velkommen til IQ Rest, {name}!",
    greeting: "Hei {name},",
    body: "Jeg heter Bogdan, og jeg skal ta hånd om kontoen din hos IQ Rest.",
    help: "Hvis du har spørsmål om oppsett av QR-menyen, nettstedet, reservasjoner eller noe annet — bare svar på denne e-posten. Jeg er her for å hjelpe.",
    closing: "Gleder meg til å jobbe sammen!",
    signature: "Vennlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pl: {
    subject: "Witamy w IQ Rest, {name}!",
    greeting: "Cześć {name},",
    body: "Jestem Bogdan i będę zajmował się Twoim kontem w IQ Rest.",
    help: "Jeśli masz pytania dotyczące konfiguracji menu QR, strony internetowej, rezerwacji lub czegokolwiek innego — po prostu odpowiedz na tego e-maila. Jestem tu, aby pomóc.",
    closing: "Cieszę się na współpracę!",
    signature: "Pozdrawiam,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pt: {
    subject: "Bem-vindo ao IQ Rest, {name}!",
    greeting: "Olá {name},",
    body: "Sou o Bogdan e cuidarei da sua conta no IQ Rest.",
    help: "Se tiver alguma dúvida sobre como configurar o seu menu QR, site, reservas ou qualquer outra coisa — basta responder a este e-mail. Estou aqui para ajudar.",
    closing: "Espero trabalhar consigo!",
    signature: "Com os melhores cumprimentos,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ro: {
    subject: "Bine ați venit la IQ Rest, {name}!",
    greeting: "Salut {name},",
    body: "Sunt Bogdan și mă voi ocupa de contul tău la IQ Rest.",
    help: "Dacă ai întrebări despre configurarea meniului QR, site-ului, rezervărilor sau orice altceva — pur și simplu răspunde la acest e-mail. Sunt aici să te ajut.",
    closing: "Aștept cu nerăbdare să lucrăm împreună!",
    signature: "Cu stimă,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ru: {
    subject: "Добро пожаловать в IQ Rest, {name}!",
    greeting: "Здравствуйте, {name},",
    body: "Я Богдан, и я буду заниматься вашим аккаунтом в IQ Rest.",
    help: "Если у вас возникнут вопросы по настройке QR-меню, сайта, бронирования или чего-либо ещё — просто ответьте на это письмо. Я здесь, чтобы помочь.",
    closing: "С нетерпением жду совместной работы!",
    signature: "С уважением,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sk: {
    subject: "Vitajte v IQ Rest, {name}!",
    greeting: "Ahoj {name},",
    body: "Som Bogdan a budem sa starať o váš účet v IQ Rest.",
    help: "Ak máte otázky ohľadom nastavenia QR menu, webovej stránky, rezervácií alebo čohokoľvek iného — stačí odpovedať na tento e-mail. Som tu, aby som pomohol.",
    closing: "Teším sa na spoluprácu!",
    signature: "S pozdravom,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sl: {
    subject: "Dobrodošli v IQ Rest, {name}!",
    greeting: "Pozdravljeni {name},",
    body: "Sem Bogdan in skrbel bom za vaš račun v IQ Rest.",
    help: "Če imate vprašanja glede nastavitve QR menija, spletne strani, rezervacij ali česarkoli drugega — preprosto odgovorite na ta e-mail. Tu sem, da pomagam.",
    closing: "Veselim se sodelovanja!",
    signature: "Lep pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sr: {
    subject: "Добродошли у IQ Rest, {name}!",
    greeting: "Здраво {name},",
    body: "Ја сам Богдан и бринућу о вашем налогу на IQ Rest.",
    help: "Ако имате питања о подешавању QR менија, веб сајта, резервација или било чега другог — једноставно одговорите на овај имејл. Ту сам да помогнем.",
    closing: "Радујем се сарадњи!",
    signature: "Срдачан поздрав,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sv: {
    subject: "Välkommen till IQ Rest, {name}!",
    greeting: "Hej {name},",
    body: "Jag heter Bogdan och kommer att ta hand om ditt konto hos IQ Rest.",
    help: "Om du har frågor om att ställa in din QR-meny, webbplats, bokningar eller något annat — svara bara på det här e-postmeddelandet. Jag finns här för att hjälpa.",
    closing: "Ser fram emot att jobba med dig!",
    signature: "Vänliga hälsningar,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  tr: {
    subject: "IQ Rest'e hoş geldiniz, {name}!",
    greeting: "Merhaba {name},",
    body: "Ben Bogdan ve IQ Rest'teki hesabınızla ben ilgileneceğim.",
    help: "QR menünüz, web siteniz, rezervasyonlarınız veya başka bir şeyin kurulumu hakkında sorularınız varsa — bu e-postaya yanıt vermeniz yeterli. Yardım etmek için buradayım.",
    closing: "Sizinle çalışmayı dört gözle bekliyorum!",
    signature: "Saygılarımla,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  uk: {
    subject: "Ласкаво просимо до IQ Rest, {name}!",
    greeting: "Привіт {name},",
    body: "Я Богдан, і я буду опікуватися вашим обліковим записом у IQ Rest.",
    help: "Якщо у вас є запитання щодо налаштування QR-меню, веб-сайту, бронювань або будь-чого іншого — просто дайте відповідь на цей лист. Я тут, щоб допомогти.",
    closing: "З нетерпінням чекаю на нашу співпрацю!",
    signature: "З повагою,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  zh: {
    subject: "欢迎使用 IQ Rest，{name}！",
    greeting: "{name}，您好，",
    body: "我是 Bogdan，将负责您在 IQ Rest 的账户。",
    help: "如果您对设置 QR 菜单、网站、预订或任何其他方面有任何疑问 — 只需回复此电子邮件。我在这里为您提供帮助。",
    closing: "期待与您合作！",
    signature: "此致,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
};

const RTL = new Set(["ar", "fa"]);
export function isRtl(locale: string): boolean {
  return RTL.has(locale);
}

export function pickWelcomePersonal(locale: string): T {
  return WELCOME_PERSONAL[locale] || WELCOME_PERSONAL.en;
}
