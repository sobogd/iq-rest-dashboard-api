// Menu-almost-ready reminder — sent manually from the admin panel to nudge a
// restaurant owner whose QR menu is partially set up. {name} = restaurant
// title (or email local-part as fallback). Tone matches welcome_personal:
// personal note from Bogdan, light commitment, no urgency trigger.

interface T {
  subject: string;
  greeting: string;
  body: string;
  help: string;
  closing: string;
  signature: string;
}

const DASHBOARD_URL = "dashboard.iq-rest.com";

export const MENU_ALMOST_READY: Record<string, T> = {
  ar: {
    subject: "قائمة QR الخاصة بـ {name} شبه جاهزة",
    greeting: "مرحبًا {name}،",
    body: "لاحظت أنك بدأت إعداد قائمة QR في IQ Rest ولم تكملها بعد. عادةً ما تكون مجرد لمسات قليلة متبقية — بضعة أطباق أو صور أو تفعيل الطلبات عبر الإنترنت — وتصبح القائمة جاهزة للعرض على الضيوف.",
    help: `إذا أردت، يمكنني مرافقتك خلال ما تبقى — يستغرق الأمر 10 دقائق، فقط رد على هذا البريد. أو ادخل إلى لوحة التحكم وأكمل من حيث توقفت: ${DASHBOARD_URL}`,
    closing: "سأكون سعيدًا برؤية قائمتك تعمل.",
    signature: "مع أطيب التحيات،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  bg: {
    subject: "QR менюто на {name} е почти готово",
    greeting: "Здравей {name},",
    body: "Забелязах, че започна да настройваш QR менюто си в IQ Rest, но още не си го завършил. Обикновено остават само няколко детайла — няколко ястия, снимки или активирани онлайн поръчки — и менюто е готово да се покаже на гостите.",
    help: `Ако искаш, ще премина с теб през останалото — отнема 10 минути, просто отговори на този имейл. Или влез в панела и продължи откъдето си спрял: ${DASHBOARD_URL}`,
    closing: "Ще се радвам да видя менюто ти в действие.",
    signature: "С уважение,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  ca: {
    subject: "El menú QR de {name} està gairebé llest",
    greeting: "Hola {name},",
    body: "He vist que has començat a configurar el teu menú QR a IQ Rest però encara no l'has acabat. Normalment només falten un parell de detalls — alguns plats, fotos o activar les comandes en línia — i el menú ja es pot mostrar als clients.",
    help: `Si vols, et puc acompanyar a acabar la resta — són 10 minuts, només respon a aquest correu. O entra al panell i continua on ho havies deixat: ${DASHBOARD_URL}`,
    closing: "Tinc ganes de veure el teu menú en marxa.",
    signature: "Salutacions,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  cs: {
    subject: "QR menu pro {name} je téměř hotové",
    greeting: "Ahoj {name},",
    body: "Všiml jsem si, že jste začali nastavovat své QR menu v IQ Rest, ale ještě jste ho nedokončili. Obvykle zbývá jen pár drobností — několik jídel, fotky nebo aktivované online objednávky — a menu může jít k hostům.",
    help: `Pokud chcete, projdu zbytek s vámi — trvá to 10 minut, stačí odpovědět na tento e-mail. Nebo se přihlaste do panelu a pokračujte tam, kde jste skončili: ${DASHBOARD_URL}`,
    closing: "Budu rád, když uvidím vaše menu v provozu.",
    signature: "S pozdravem,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  da: {
    subject: "QR-menuen til {name} er næsten klar",
    greeting: "Hej {name},",
    body: "Jeg lagde mærke til, at du er begyndt at sætte din QR-menu op i IQ Rest, men ikke har gjort den færdig endnu. Som regel mangler der bare et par detaljer — nogle retter, billeder eller aktivering af online bestillinger — og så er menuen klar til gæsterne.",
    help: `Hvis du vil, går jeg resten igennem sammen med dig — det tager 10 minutter, svar bare på denne e-mail. Eller log ind på panelet og fortsæt, hvor du slap: ${DASHBOARD_URL}`,
    closing: "Glæder mig til at se din menu i brug.",
    signature: "Venlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  de: {
    subject: "Das QR-Menü von {name} ist fast fertig",
    greeting: "Hallo {name},",
    body: "Mir ist aufgefallen, dass Sie Ihr QR-Menü in IQ Rest schon angelegt, aber noch nicht abgeschlossen haben. Meistens fehlen nur ein paar Kleinigkeiten — ein paar Gerichte, Fotos oder die Aktivierung der Online-Bestellungen — und das Menü kann den Gästen gezeigt werden.",
    help: `Wenn Sie möchten, gehe ich den Rest mit Ihnen durch — 10 Minuten, antworten Sie einfach auf diese E-Mail. Oder melden Sie sich im Panel an und machen dort weiter, wo Sie aufgehört haben: ${DASHBOARD_URL}`,
    closing: "Ich freue mich, Ihr Menü im Einsatz zu sehen.",
    signature: "Mit freundlichen Grüßen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  el: {
    subject: "Το QR μενού του {name} είναι σχεδόν έτοιμο",
    greeting: "Γεια σου {name},",
    body: "Παρατήρησα ότι ξεκίνησες να ρυθμίζεις το QR μενού σου στο IQ Rest αλλά δεν το ολοκλήρωσες ακόμη. Συνήθως μένουν λίγες λεπτομέρειες — μερικά πιάτα, φωτογραφίες ή ενεργοποίηση των online παραγγελιών — και το μενού είναι έτοιμο για τους πελάτες.",
    help: `Αν θες, περνάμε μαζί τα υπόλοιπα — 10 λεπτά, απλά απάντησε σε αυτό το email. Ή μπες στον πίνακα και συνέχισε από εκεί που σταμάτησες: ${DASHBOARD_URL}`,
    closing: "Ανυπομονώ να δω το μενού σου σε λειτουργία.",
    signature: "Με εκτίμηση,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  en: {
    subject: "Your QR menu for {name} is almost ready",
    greeting: "Hi {name},",
    body: "I noticed you started setting up your QR menu in IQ Rest but haven't finished yet. Usually it's just a few details left — a couple of dishes, photos, or enabling online orders — and the menu is ready to show to your guests.",
    help: `If you'd like, I can walk you through what's left — it takes 10 minutes, just reply to this email. Or log into the dashboard and pick up where you left off: ${DASHBOARD_URL}`,
    closing: "Looking forward to seeing your menu in action.",
    signature: "Best regards,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  es: {
    subject: "El menú QR de {name} está casi listo",
    greeting: "Hola {name},",
    body: "He visto que has empezado a configurar tu menú QR en IQ Rest pero aún no lo has terminado. Normalmente solo quedan un par de detalles — algunos platos, fotos o activar los pedidos online — y el menú está listo para mostrarlo a los clientes.",
    help: `Si quieres, te acompaño con lo que falta — son 10 minutos, solo responde a este correo. O entra al panel y continúa donde lo dejaste: ${DASHBOARD_URL}`,
    closing: "Tengo ganas de ver tu menú en funcionamiento.",
    signature: "Un saludo,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  et: {
    subject: "Sinu QR-menüü {name} jaoks on peaaegu valmis",
    greeting: "Tere {name},",
    body: "Märkasin, et alustasid oma QR-menüü seadistamist IQ Restis, kuid pole seda veel lõpetanud. Tavaliselt on jäänud vaid mõned pisidetailid — paar rooga, fotod või veebitellimuste sisselülitamine — ja menüü on valmis külalistele näidata.",
    help: `Kui soovid, võtame ülejäänu koos läbi — see võtab 10 minutit, vasta lihtsalt sellele kirjale. Või logi paneelile ja jätka sealt, kus pooleli jäid: ${DASHBOARD_URL}`,
    closing: "Ootan, millal su menüü tööle hakkab.",
    signature: "Parimate soovidega,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fa: {
    subject: "منوی QR شما برای {name} تقریباً آماده است",
    greeting: "سلام {name}،",
    body: "متوجه شدم که تنظیم منوی QR خود را در IQ Rest شروع کرده‌اید اما هنوز کامل نکرده‌اید. معمولاً فقط چند جزئیات باقی مانده — چند غذا، عکس یا فعال‌سازی سفارش آنلاین — و منو آماده نمایش به مهمانان است.",
    help: `اگر بخواهید، من همراهتان مراحل باقی‌مانده را طی می‌کنم — ۱۰ دقیقه طول می‌کشد، کافیست به این ایمیل پاسخ دهید. یا وارد پنل شوید و از همان جایی که متوقف شده‌اید ادامه دهید: ${DASHBOARD_URL}`,
    closing: "منتظر دیدن منوی شما در عمل هستم.",
    signature: "با احترام،<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fi: {
    subject: "QR-valikkosi kohteelle {name} on melkein valmis",
    greeting: "Hei {name},",
    body: "Huomasin, että aloitit QR-valikkosi rakentamisen IQ Restissä, mutta et ole vielä saanut sitä valmiiksi. Yleensä vain pari yksityiskohtaa puuttuu — muutama annos, kuvat tai verkkotilausten aktivointi — ja valikko on valmis vieraille näytettäväksi.",
    help: `Jos haluat, käyn loput läpi kanssasi — se vie 10 minuuttia, vastaa vain tähän viestiin. Tai kirjaudu paneeliin ja jatka siitä, mihin jäit: ${DASHBOARD_URL}`,
    closing: "Odotan innolla nähdä valikkosi käytössä.",
    signature: "Ystävällisin terveisin,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  fr: {
    subject: "Votre menu QR pour {name} est presque prêt",
    greeting: "Bonjour {name},",
    body: "J'ai remarqué que vous avez commencé à configurer votre menu QR dans IQ Rest mais que vous ne l'avez pas encore terminé. Il ne manque souvent que quelques détails — quelques plats, des photos ou l'activation des commandes en ligne — et le menu est prêt à être présenté à vos clients.",
    help: `Si vous le souhaitez, je peux passer en revue ce qu'il reste avec vous — cela prend 10 minutes, répondez simplement à cet e-mail. Ou connectez-vous au tableau de bord et reprenez où vous en étiez : ${DASHBOARD_URL}`,
    closing: "J'ai hâte de voir votre menu en action.",
    signature: "Cordialement,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ga: {
    subject: "Tá biachlár QR {name} beagnach réidh",
    greeting: "Dia duit {name},",
    body: "Thug mé faoi deara go bhfuil tús curtha agat le do bhiachlár QR a chumrú in IQ Rest ach nár chríochnaigh tú fós é. Is gnách nach mbíonn fágtha ach cúpla mionsonra — cúpla mias, grianghraif nó orduithe ar líne a chumasú — agus tá an biachlár réidh do na haíonna.",
    help: `Más mian leat, rachaidh mé tríd an gcuid eile leat — tógann sé 10 nóiméad, ní gá ach freagra a thabhairt ar an ríomhphost seo. Nó logáil isteach sa phainéal agus lean ort san áit ar fhág tú: ${DASHBOARD_URL}`,
    closing: "Táim ag tnúth le do bhiachlár a fheiceáil i mbun oibre.",
    signature: "Le meas,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hr: {
    subject: "QR jelovnik za {name} je gotovo spreman",
    greeting: "Pozdrav {name},",
    body: "Primijetio sam da ste počeli postavljati svoj QR jelovnik u IQ Rest, ali ga još niste dovršili. Obično je preostalo samo nekoliko detalja — nekoliko jela, fotografije ili uključivanje online narudžbi — i jelovnik je spreman za goste.",
    help: `Ako želite, proći ću s vama ostatak — traje 10 minuta, samo odgovorite na ovaj e-mail. Ili se prijavite u panel i nastavite tamo gdje ste stali: ${DASHBOARD_URL}`,
    closing: "Veselim se kada ću vidjeti vaš jelovnik u upotrebi.",
    signature: "Lijep pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  hu: {
    subject: "A {name} QR-menüje majdnem készen áll",
    greeting: "Szia {name},",
    body: "Észrevettem, hogy elkezdted a QR-menüd beállítását az IQ Restben, de még nem fejezted be. Általában csak néhány apróság hiányzik — pár étel, fotók vagy az online rendelés bekapcsolása — és a menü kész, hogy bemutasd a vendégeknek.",
    help: `Ha szeretnéd, végigmegyek veled a hátralévőn — 10 perc, csak válaszolj erre az e-mailre. Vagy lépj be a vezérlőpultba és folytasd onnan, ahol abbahagytad: ${DASHBOARD_URL}`,
    closing: "Várom, hogy lássam a menüd működés közben.",
    signature: "Üdvözlettel,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  is: {
    subject: "QR-matseðillinn fyrir {name} er næstum tilbúinn",
    greeting: "Halló {name},",
    body: "Ég tók eftir að þú byrjaðir að setja upp QR-matseðilinn þinn í IQ Rest en hefur ekki klárað hann enn. Yfirleitt eru aðeins nokkur smáatriði eftir — nokkrir réttir, ljósmyndir eða að virkja netpantanir — og matseðillinn er tilbúinn fyrir gestina.",
    help: `Ef þú vilt fer ég yfir það sem eftir er með þér — það tekur 10 mínútur, svaraðu bara þessum tölvupósti. Eða skráðu þig inn á stjórnborðið og haltu áfram þar sem þú hættir: ${DASHBOARD_URL}`,
    closing: "Ég hlakka til að sjá matseðilinn þinn í notkun.",
    signature: "Með bestu kveðjum,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  it: {
    subject: "Il menu QR di {name} è quasi pronto",
    greeting: "Ciao {name},",
    body: "Ho notato che hai iniziato a configurare il tuo menu QR in IQ Rest ma non l'hai ancora completato. Di solito mancano solo un paio di dettagli — alcuni piatti, foto o l'attivazione degli ordini online — e il menu è pronto per essere mostrato agli ospiti.",
    help: `Se vuoi, posso accompagnarti con quello che resta — sono 10 minuti, basta rispondere a questa email. Oppure entra nel pannello e riprendi da dove ti eri fermato: ${DASHBOARD_URL}`,
    closing: "Non vedo l'ora di vedere il tuo menu in azione.",
    signature: "Cordiali saluti,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ja: {
    subject: "{name}様のQRメニューはあと少しで完成です",
    greeting: "{name}様、こんにちは。",
    body: "IQ RestでのQRメニューの設定を始めていただいたものの、まだ完成していないようですね。残っているのはたいてい数項目だけです — 数品の追加、写真、またはオンライン注文の有効化 — それでお客様にお見せできる状態になります。",
    help: `よろしければ、残りの部分を一緒に進めさせてください — 10分で終わります、このメールに返信するだけで結構です。あるいはダッシュボードにログインして、続きから進めていただけます: ${DASHBOARD_URL}`,
    closing: "メニューが稼働するのを楽しみにしています。",
    signature: "敬具<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ko: {
    subject: "{name}의 QR 메뉴가 거의 준비되었습니다",
    greeting: "{name}님, 안녕하세요.",
    body: "IQ Rest에서 QR 메뉴 설정을 시작하셨지만 아직 완료하지 않으신 것 같습니다. 보통은 몇 가지 세부 사항만 남아 있습니다 — 메뉴 항목 몇 개, 사진, 또는 온라인 주문 활성화 — 그러면 손님에게 보여드릴 수 있습니다.",
    help: `원하시면 남은 부분을 함께 마무리해 드립니다 — 10분이면 됩니다, 이 이메일에 답장만 주세요. 아니면 대시보드에 로그인하셔서 멈추신 곳부터 이어서 진행하실 수 있습니다: ${DASHBOARD_URL}`,
    closing: "메뉴가 실제로 운영되는 모습을 기대하겠습니다.",
    signature: "감사합니다.<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lt: {
    subject: "Jūsų QR meniu {name} beveik paruoštas",
    greeting: "Sveiki, {name},",
    body: "Pastebėjau, kad pradėjote konfigūruoti savo QR meniu IQ Rest, bet dar nepabaigėte. Paprastai lieka tik keli smulkmenos — pora patiekalų, nuotraukos arba įjungti internetiniai užsakymai — ir meniu paruoštas rodyti svečiams.",
    help: `Jei norite, kartu peržiūrėsime tai, kas liko — užtruks 10 minučių, tiesiog atsakykite į šį laišką. Arba prisijunkite prie skydelio ir tęskite ten, kur sustojote: ${DASHBOARD_URL}`,
    closing: "Lauksiu, kol pamatysiu jūsų meniu veikiantį.",
    signature: "Pagarbiai,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  lv: {
    subject: "Jūsu QR ēdienkarte {name} ir gandrīz gatava",
    greeting: "Sveiki, {name},",
    body: "Pamanīju, ka esat sācis iestatīt savu QR ēdienkarti IQ Rest, bet vēl neesat to pabeidzis. Parasti palikušas tikai dažas detaļas — daži ēdieni, fotoattēli vai tiešsaistes pasūtījumu aktivizēšana — un ēdienkarte ir gatava viesiem.",
    help: `Ja vēlaties, es kopā ar jums izietu cauri atlikušajam — tas aizņem 10 minūtes, vienkārši atbildiet uz šo e-pastu. Vai pieslēdzieties panelim un turpiniet no vietas, kur apstājāties: ${DASHBOARD_URL}`,
    closing: "Gaidu, kad redzēšu jūsu ēdienkarti darbībā.",
    signature: "Ar cieņu,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  nl: {
    subject: "Het QR-menu van {name} is bijna klaar",
    greeting: "Hallo {name},",
    body: "Ik zag dat je begonnen bent met het instellen van je QR-menu in IQ Rest, maar het nog niet hebt afgemaakt. Vaak zijn er nog maar een paar details over — een paar gerechten, foto's of het activeren van online bestellingen — en dan kan het menu aan je gasten worden getoond.",
    help: `Als je wilt, loop ik de rest met je door — het duurt 10 minuten, antwoord gewoon op deze e-mail. Of log in op het paneel en ga verder waar je gebleven was: ${DASHBOARD_URL}`,
    closing: "Ik kijk uit naar het zien van je menu in actie.",
    signature: "Met vriendelijke groet,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  no: {
    subject: "QR-menyen for {name} er nesten klar",
    greeting: "Hei {name},",
    body: "Jeg la merke til at du har begynt å sette opp QR-menyen din i IQ Rest, men ikke fullført ennå. Vanligvis gjenstår bare noen få detaljer — et par retter, bilder eller å aktivere onlinebestilling — og menyen er klar til å vises for gjestene.",
    help: `Hvis du vil, går jeg gjennom resten med deg — det tar 10 minutter, bare svar på denne e-posten. Eller logg inn i panelet og fortsett der du slapp: ${DASHBOARD_URL}`,
    closing: "Gleder meg til å se menyen din i bruk.",
    signature: "Med vennlig hilsen,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pl: {
    subject: "Menu QR dla {name} jest prawie gotowe",
    greeting: "Cześć {name},",
    body: "Zauważyłem, że zacząłeś konfigurować swoje menu QR w IQ Rest, ale jeszcze go nie skończyłeś. Zazwyczaj zostało już tylko kilka drobiazgów — kilka dań, zdjęcia lub włączenie zamówień online — i menu jest gotowe, by pokazać je gościom.",
    help: `Jeśli chcesz, przejdę z tobą przez to, co zostało — zajmie to 10 minut, wystarczy odpowiedzieć na tę wiadomość. Albo zaloguj się do panelu i kontynuuj tam, gdzie skończyłeś: ${DASHBOARD_URL}`,
    closing: "Nie mogę się doczekać, kiedy zobaczę twoje menu w działaniu.",
    signature: "Pozdrawiam,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  pt: {
    subject: "O menu QR de {name} está quase pronto",
    greeting: "Olá {name},",
    body: "Reparei que começou a configurar o seu menu QR no IQ Rest mas ainda não o terminou. Normalmente só faltam alguns detalhes — alguns pratos, fotos ou ativar os pedidos online — e o menu fica pronto para mostrar aos clientes.",
    help: `Se quiser, posso acompanhá-lo no que falta — são 10 minutos, basta responder a este e-mail. Ou entre no painel e continue onde parou: ${DASHBOARD_URL}`,
    closing: "Estou ansioso por ver o seu menu em funcionamento.",
    signature: "Com os melhores cumprimentos,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ro: {
    subject: "Meniul QR pentru {name} este aproape gata",
    greeting: "Salut {name},",
    body: "Am observat că ai început să configurezi meniul QR în IQ Rest, dar încă nu l-ai finalizat. De obicei mai rămân doar câteva detalii — câteva preparate, fotografii sau activarea comenzilor online — și meniul e gata să fie arătat clienților.",
    help: `Dacă vrei, parcurg împreună cu tine ce a rămas — durează 10 minute, doar răspunde la acest e-mail. Sau intră în panou și continuă de unde ai rămas: ${DASHBOARD_URL}`,
    closing: "Aștept cu nerăbdare să văd meniul tău în acțiune.",
    signature: "Cu stimă,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  ru: {
    subject: "Ваше QR-меню {name} почти готово",
    greeting: "Здравствуйте, {name}!",
    body: "Я заметил, что вы начали настраивать QR-меню в IQ Rest, но пока не довели его до конца. Чаще всего это пара недостающих штрихов — несколько блюд, фотографии или включённый онлайн-заказ — и меню уже можно показывать гостям.",
    help: `Если хотите, я пройдусь по оставшемуся вместе с вами — это 10 минут, просто ответьте на это письмо. Или зайдите в кабинет и продолжите там, где остановились: ${DASHBOARD_URL}`,
    closing: "Буду рад увидеть ваше меню в деле.",
    signature: "С уважением,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sk: {
    subject: "QR menu pre {name} je takmer hotové",
    greeting: "Ahoj {name},",
    body: "Všimol som si, že ste začali nastavovať svoje QR menu v IQ Rest, ale ešte ste ho nedokončili. Zvyčajne zostáva už len pár detailov — pár jedál, fotografie alebo aktivácia online objednávok — a menu je pripravené pre hostí.",
    help: `Ak chcete, prejdem zvyšok s vami — trvá to 10 minút, stačí odpovedať na tento e-mail. Alebo sa prihláste do panela a pokračujte tam, kde ste skončili: ${DASHBOARD_URL}`,
    closing: "Teším sa, keď uvidím vaše menu v prevádzke.",
    signature: "S pozdravom,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sl: {
    subject: "Vaš QR meni za {name} je skoraj pripravljen",
    greeting: "Pozdravljeni {name},",
    body: "Opazil sem, da ste začeli nastavljati svoj QR meni v IQ Rest, vendar ga še niste dokončali. Običajno ostane le nekaj podrobnosti — nekaj jedi, fotografije ali aktivacija spletnih naročil — in meni je pripravljen za goste.",
    help: `Če želite, gremo skupaj skozi preostanek — traja 10 minut, samo odgovorite na to sporočilo. Ali se prijavite v ploščo in nadaljujte tam, kjer ste končali: ${DASHBOARD_URL}`,
    closing: "Veselim se, ko bom videl vaš meni v uporabi.",
    signature: "Lep pozdrav,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  sr: {
    subject: "QR мени за {name} је скоро спреман",
    greeting: "Здраво {name},",
    body: "Приметио сам да сте почели да подешавате свој QR мени у IQ Rest, али га још нисте завршили. Обично остане још само неколико детаља — пар јела, фотографије или укључивање онлајн поруџбина — и мени је спреман за госте.",
    help: `Ако желите, прођимо заједно кроз остатак — траје 10 минута, само одговорите на овај имејл. Или се пријавите на панел и наставите тамо где сте стали: ${DASHBOARD_URL}`,
    closing: "Радујем се када будем видео ваш мени у употреби.",
    signature: "Срдачан поздрав,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  sv: {
    subject: "QR-menyn för {name} är nästan klar",
    greeting: "Hej {name},",
    body: "Jag märkte att du har börjat ställa in din QR-meny i IQ Rest men inte avslutat den än. Oftast återstår bara några detaljer — några rätter, bilder eller att aktivera onlinebeställningar — och menyn är klar att visa för gästerna.",
    help: `Om du vill går jag igenom resten med dig — det tar 10 minuter, svara bara på det här mejlet. Eller logga in på panelen och fortsätt där du slutade: ${DASHBOARD_URL}`,
    closing: "Ser fram emot att se din meny i bruk.",
    signature: "Vänliga hälsningar,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  tr: {
    subject: "{name} için QR menünüz neredeyse hazır",
    greeting: "Merhaba {name},",
    body: "IQ Rest'te QR menünüzü kurmaya başladığınızı ancak henüz tamamlamadığınızı fark ettim. Genellikle geriye birkaç ayrıntı kalır — birkaç yemek, fotoğraflar veya online siparişlerin aktif edilmesi — ve menü misafirlere gösterilmeye hazır olur.",
    help: `İsterseniz kalan kısımdan birlikte geçeriz — 10 dakika sürer, bu e-postayı yanıtlamanız yeterli. Ya da panele giriş yapıp kaldığınız yerden devam edebilirsiniz: ${DASHBOARD_URL}`,
    closing: "Menünüzü çalışırken görmeyi dört gözle bekliyorum.",
    signature: "Saygılarımla,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
  uk: {
    subject: "Ваше QR-меню {name} майже готове",
    greeting: "Вітаю, {name},",
    body: "Я помітив, що ви почали налаштовувати QR-меню в IQ Rest, але ще не довели його до кінця. Зазвичай залишається кілька дрібниць — пара страв, фотографії або увімкнене онлайн-замовлення — і меню готове показати гостям.",
    help: `Якщо хочете, я пройдуся з вами по тому, що залишилось — це 10 хвилин, просто дайте відповідь на цей лист. Або зайдіть до панелі й продовжіть там, де зупинились: ${DASHBOARD_URL}`,
    closing: "З нетерпінням чекаю побачити ваше меню в роботі.",
    signature: "З повагою,<br>Богдан<br>IQ Rest | iq-rest.com",
  },
  zh: {
    subject: "{name} 的 QR 菜单即将就绪",
    greeting: "{name}，您好，",
    body: "我注意到您已经开始在 IQ Rest 中设置 QR 菜单，但尚未完成。通常只剩下几个细节 — 几道菜、照片或开启在线下单 — 然后菜单就可以展示给您的客人了。",
    help: `如果您愿意，我可以陪您完成剩下的部分 — 只需 10 分钟，只要回复这封邮件即可。或者登录控制台，从您上次停下的地方继续: ${DASHBOARD_URL}`,
    closing: "期待看到您的菜单投入使用。",
    signature: "此致,<br>Bogdan<br>IQ Rest | iq-rest.com",
  },
};

const RTL = new Set(["ar", "fa"]);
export function isRtl(locale: string): boolean {
  return RTL.has(locale);
}

export function pickMenuAlmostReady(locale: string): T {
  return MENU_ALMOST_READY[locale] || MENU_ALMOST_READY.en;
}
