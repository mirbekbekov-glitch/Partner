/**
 * Языки публичной части: кыргызский, русский, английский, китайский.
 *
 * Язык живёт В ПУТИ (/ky, /ru, /en, /zh), а не в cookie. Ссылкой на
 * объявление делятся — и она должна открыться на том языке, на котором её
 * отправили; поисковик тоже должен видеть четыре версии, а не одну.
 *
 * Переводятся только подписи интерфейса. Адрес объекта и описание пишет
 * агент своими словами, и машинного перевода тут не будет: цена ошибки в
 * описании недвижимости выше, чем польза от приблизительного текста.
 */
export const LANGS = ['ky', 'ru', 'en', 'zh'] as const;
export type Lang = (typeof LANGS)[number];
export const DEFAULT_LANG: Lang = 'ru';

export const LANG_NAMES: Record<Lang, string> = {
  ky: 'Кыргызча',
  ru: 'Русский',
  en: 'English',
  zh: '中文',
};

export const isLang = (v: unknown): v is Lang =>
  typeof v === 'string' && (LANGS as readonly string[]).includes(v);

/** Код для атрибута lang и для Intl: кыргызский — ky-KG. */
export const LOCALE: Record<Lang, string> = {
  ky: 'ky-KG', ru: 'ru-RU', en: 'en-US', zh: 'zh-CN',
};

type Dict = {
  // Шапка и подвал
  forAgents: string; forAgentsShort: string; themeSwitch: string; agency: string; city: string; phones: string; sections: string;
  agencyLine: (place: string) => string; cabinetLine: string;
  /** Страна — подставляется вместо города, когда городов несколько. */
  country: string;
  // Герой
  heroTitle: string; heroEm: string;
  // Поиск
  address: string; addressHint: string; deal: string; anyDeal: string;
  tabBuy: string; tabRent: string;
  moreFilters: string; priceFrom: string;
  sale: string; rent: string; kind: string; anyKind: string;
  rooms: string; anyRooms: string; priceTo: string;
  search: string; searchCount: (n: number) => string; reset: string;
  // Выдача
  forSale: string; forRent: string;
  sortFresh: string; sortCheap: string; sortBig: string;
  nothingFound: string; nothingYet: string; catalogDown: string;
  pageOf: (cur: number, total: number) => string;
  back: string; forward: string;
  // Карточка
  perMonth: string; confirmedBy: string;
  today: string; yesterday: string; daysAgo: (n: number) => string;
  objectsCount: (n: number) => string;
  // Страница объекта
  toAll: string; about: string; published: string; roomsLabel: string;
  areaLabel: string; floorLabel: string; floorOf: string; zoneLabel: string; cityLabel: string;
  zoneSearch: string; zoneNone: string; regionLabel: string; otherPlaces: string;
  callAgent: string; writeWhatsapp: string; writeTelegram: string;
  confirmedPrice: string; notFound: string; notFoundLede: string; seeWhatIsThere: string;
  // Блок агента на странице объекта. Открыты ровно три поля: имя, стаж и
  // подтверждённый номер в реестре. Телефон агента здесь намеренно
  // отсутствует — звонки идут в отдел продаж, а не минуя его.
  agentLeads: string; agentYears: (n: number) => string;
  agentRegistry: (no: string) => string; agentRegistryNote: string;
  // Публичная страница агента
  agentsNav: string; agentsTitle: string; agentsLede: string;
  agentsEmpty: string; agentObjects: (n: number) => string;
  agentNotFound: string; toAgents: string; agentOf: string;
  // Заявка
  viewObject: string; leadNote: string; yourName: string; phone: string;
  phoneNote: string; whenConvenient: string; sendRequest: string; sending: string;
  sent: string; sentNote: (address: string) => string; callNow: string; salesDept: string;
  errPhone: string; errName: string; errMany: string; errGone: string; errGeneric: string;
  // Мелкие подписи и подсказки в полях
  roomsShort: string; sqm: string; floorShort: string; priceHint: string;
  namePlaceholder: string; phonePlaceholder: string;
  messageLabel: string; messagePlaceholder: string; honeypotLabel: string;
  // siteTitle — без названия агентства: его добавляет шаблон title в
  // app/layout.tsx ('%s — Liberterra'). Если вписать бренд сюда, во вкладке
  // и в выдаче он удвоится.
  siteTitle: string; siteDescription: string; drawingAlt: string;
  // Полоса «оставьте заявку» на главной
  pitchEyebrow: string; pitchTitle: string; pitchLede: string; pitchButton: string;
  pitchStep1: string; pitchStep1Note: string;
  pitchStep2: string; pitchStep2Note: string;
  pitchStep3: string; pitchStep3Note: string;
  // Заявка «что я ищу»
  reqNav: string; reqTitle: string; reqLede: string;
  reqDeal: string; reqBuy: string; reqRent: string;
  reqType: string; reqRooms: string; reqDistrict: string; reqDistrictAny: string;
  reqBudget: string; reqWishes: string; reqWishesHint: string;
  reqConsent: string; reqConsentHint: string;
  reqSend: string; reqSending: string; reqSent: string; reqSentNote: string;
  reqErrPhone: string; reqErrInput: string; reqErrMany: string; reqErrGeneric: string;
  reqWhy1: string; reqWhy2: string; reqWhy3: string;
  // Типы недвижимости
  kinds: Record<string, string>;
};

const plural = (n: number, one: string, few: string, many: string) => {
  const d = n % 10, h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 10 || h >= 20)) return few;
  return many;
};

const ru: Dict = {
  forAgents: 'Вход для агентов', agency: 'Liberterra', phones: 'Телефоны',
  sections: 'Разделы', agencyLine: (place) => `Агентство недвижимости, ${place}`,
  country: 'Кыргызстан',
  cabinetLine: 'Кабинет и CRM — по входу для агентов.',
  heroTitle: 'Найдите своё пространство для комфортной', heroEm: 'работы и жилья',
  address: 'Адрес или район', addressHint: 'Чүй, Асанбай, Джал…',
  deal: 'Сделка', anyDeal: 'Любая', sale: 'Продажа', rent: 'Аренда',
  kind: 'Тип', anyKind: 'Любой', rooms: 'Комнат', anyRooms: 'Любое',
  priceTo: 'Цена до', search: 'Показать', searchCount: (n) => `Найти ${n}`,
  reset: 'сбросить',
  forSale: 'В продаже', forRent: 'В аренде',
  sortFresh: 'Сначала свежие', sortCheap: 'Дешевле', sortBig: 'Больше площади',
  nothingFound: 'Под эти условия ничего не подошло. Попробуйте расширить поиск — например, убрать ограничение по цене.',
  nothingYet: 'Пока нет опубликованных объектов.',
  catalogDown: 'каталог временно недоступен',
  pageOf: (c, n) => `страница ${c} из ${n}`, back: '← назад', forward: 'вперёд →',
  perMonth: ' / мес.', confirmedBy: 'Агент подтвердил',
  today: 'сегодня', yesterday: 'вчера',
  daysAgo: (n) => `${n} ${plural(n, 'день', 'дня', 'дней')} назад`,
  objectsCount: (n) => `${n} ${plural(n, 'объект', 'объекта', 'объектов')}`,
  toAll: '← Ко всем объектам', about: 'Об объекте', published: 'Опубликован',
  roomsLabel: 'Комнат', areaLabel: 'Площадь', floorLabel: 'Этаж', floorOf: 'из',
  zoneLabel: 'Район', cityLabel: 'Город',
  zoneSearch: 'Поиск…', zoneNone: 'Такого района нет в списке',
  regionLabel: 'Регион', otherPlaces: 'Другие места',
  callAgent: 'Позвонить', writeWhatsapp: 'WhatsApp', writeTelegram: 'Telegram',
  confirmedPrice: 'Агент подтвердил цену и доступность',
  agentLeads: 'Объект ведёт',
  // «год», «года», «лет»: иначе строка читается как машинный перевод.
  agentYears: (n) =>
    `в недвижимости ${n} ${
      n % 10 === 1 && n % 100 !== 11
        ? 'год'
        : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
          ? 'года'
          : 'лет'}`,
  agentRegistry: (no) => `В реестре риэлторов: ${no}`,
  agentRegistryNote: 'Номер сверен администратором',
  agentsNav: 'Агенты', agentsTitle: 'Кто ведёт объекты',
  agentsLede: 'Каждый объект в каталоге ведёт человек с договором. Вот они.',
  agentsEmpty: 'Пока ни у кого нет опубликованных объектов.',
  agentObjects: (n) =>
    `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'объект'
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'объекта'
      : 'объектов'} в каталоге`,
  agentNotFound: 'Такого агента на сайте нет',
  toAgents: '← Все агенты', agentOf: 'Объекты агента',
  notFound: 'Страница не найдена',
  notFoundLede: 'Возможно, объект сняли с публикации или продали.',
  seeWhatIsThere: 'Посмотреть, что есть сейчас →',
  viewObject: 'Посмотреть объект',
  leadNote: 'Заявка уходит агенту, который ведёт этот объект. Телефон видит только он.',
  yourName: 'Как вас зовут', phone: 'Телефон',
  phoneNote: 'По нему с вами свяжется агент. Больше никому он не виден.',
  whenConvenient: 'Когда удобно посмотреть', sendRequest: 'Оставить заявку',
  sending: 'Отправляем…', sent: 'Заявка отправлена.',
  sentNote: (a) => `Агент, который ведёт «${a}», свяжется с вами по оставленному номеру.`,
  callNow: 'Позвонить сейчас', salesDept: 'Отдел продаж Liberterra.',
  errPhone: 'Проверьте номер телефона: по нему с вами свяжутся.',
  errName: 'Проверьте имя и текст сообщения.',
  errMany: 'Заявок с этого номера сейчас слишком много. Попробуйте через час.',
  errGone: 'Этот объект больше не в продаже.',
  errGeneric: 'Не удалось отправить заявку. Попробуйте ещё раз.',
  roomsShort: 'комн.', sqm: 'м²', floorShort: 'этаж', priceHint: '120 000',
  namePlaceholder: 'Азамат', phonePlaceholder: '+996 700 00 00 00',
  messageLabel: 'Вопрос или удобное время (необязательно)',
  messagePlaceholder: 'Можно посмотреть в субботу днём?', honeypotLabel: 'Сайт',
  siteTitle: 'Недвижимость в Бишкеке: аренда и продажа',
  siteDescription: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
  drawingAlt: 'Рисунок вместо фотографии',
  forAgentsShort: 'Вход',
  city: 'Бишкек',
  tabBuy: 'Купить', tabRent: 'Снять',
  moreFilters: 'Дополнительные фильтры', priceFrom: 'Цена от',
  reqNav: 'Заявки',
  reqTitle: 'Что вы ищете?',
  reqLede: 'Не нашли подходящее в каталоге — опишите, что нужно. Заявку разберёт агент и предложит то, чего в открытом доступе ещё нет.',
  reqDeal: 'Купить или снять', reqBuy: 'Купить', reqRent: 'Снять',
  reqType: 'Тип жилья', reqRooms: 'Комнат', reqDistrict: 'Район',
  reqDistrictAny: 'Любой район', reqBudget: 'Бюджет до',
  reqWishes: 'Что важно', reqWishesHint: 'Первый этаж не предлагать, нужен лифт и парковка',
  reqConsent: 'Разрешаю показать мой телефон агенту, который возьмёт заявку',
  reqConsentHint: 'Без этого агент увидит только параметры поиска и не сможет вам позвонить.',
  reqSend: 'Отправить заявку', reqSending: 'Отправляем…',
  reqSent: 'Заявка принята.',
  reqSentNote: 'Агент свяжется с вами в течение часа. Если найдём раньше — позвоним раньше.',
  reqErrPhone: 'Проверьте номер телефона: по нему с вами свяжутся.',
  reqErrInput: 'Проверьте заполненные поля.',
  reqErrMany: 'С этого номера сегодня уже несколько заявок. Позвоните нам напрямую.',
  reqErrGeneric: 'Не удалось отправить заявку. Попробуйте ещё раз.',
  reqWhy1: 'Отвечаем в течение часа',
  reqWhy2: 'Покажем то, чего нет в открытом каталоге',
  reqWhy3: 'Телефон увидит один агент, а не весь рынок',
  pitchEyebrow: 'Не нашли подходящее?',
  pitchTitle: 'Опишите, что ищете — искать будут агенты',
  pitchLede: 'В каталоге только то, что уже подтверждено и свободно. Остальное агенты знают, но не публикуют: хозяин просил не выкладывать, объект ещё готовится, цена обсуждается. Заявка открывает вам этот слой.',
  pitchButton: 'Оставить заявку',
  pitchStep1: 'Вы описываете, что нужно', pitchStep1Note: 'Две минуты, обязателен только телефон',
  pitchStep2: 'Заявку видят агенты', pitchStep2Note: 'Отвечаем в течение часа — это норматив, а не обещание',
  pitchStep3: 'Вам приносят варианты', pitchStep3Note: 'Появится позже — позвоним, заявка остаётся в работе',
  themeSwitch: 'Светлая или тёмная тема',
  kinds: { flat: 'квартира', room: 'комната', house: 'дом', townhouse: 'таунхаус',
           land: 'участок', commercial: 'коммерческая', garage: 'гараж' },
};

const ky: Dict = {
  forAgents: 'Агенттер үчүн кирүү', agency: 'Liberterra', phones: 'Телефондор',
  sections: 'Бөлүмдөр', agencyLine: (place) => `Кыймылсыз мүлк агенттиги, ${place}`,
  country: 'Кыргызстан',
  cabinetLine: 'Кабинет жана CRM — агенттер үчүн кирүү аркылуу.',
  heroTitle: 'Ыңгайлуу жашоо жана жумуш үчүн', heroEm: 'өз мейкиндигиңизди табыңыз',
  address: 'Дарек же район', addressHint: 'Чүй, Асанбай, Жал…',
  deal: 'Бүтүм', anyDeal: 'Баары', sale: 'Сатуу', rent: 'Ижара',
  kind: 'Түрү', anyKind: 'Баары', rooms: 'Бөлмө', anyRooms: 'Баары',
  priceTo: 'Баасы чейин', search: 'Көрсөтүү', searchCount: (n) => `${n} табуу`,
  reset: 'тазалоо',
  forSale: 'Сатууда', forRent: 'Ижарада',
  sortFresh: 'Жаңылары биринчи', sortCheap: 'Арзаныраак', sortBig: 'Аянты чоңураак',
  nothingFound: 'Бул шарттарга эч нерсе туура келген жок. Издөөнү кеңейтип көрүңүз — мисалы, баа чегин алып салыңыз.',
  nothingYet: 'Азырынча жарыяланган объекттер жок.',
  catalogDown: 'каталог убактылуу жеткиликсиз',
  pageOf: (c, n) => `${n} барактын ${c}-си`, back: '← артка', forward: 'алга →',
  perMonth: ' / айына', confirmedBy: 'Агент ырастады',
  today: 'бүгүн', yesterday: 'кечээ',
  daysAgo: (n) => `${n} күн мурун`,
  objectsCount: (n) => `${n} объект`,
  toAll: '← Бардык объекттерге', about: 'Объект жөнүндө', published: 'Жарыяланган',
  roomsLabel: 'Бөлмө', areaLabel: 'Аянты', floorLabel: 'Кабат', floorOf: '/',
  zoneLabel: 'Район', cityLabel: 'Шаар',
  zoneSearch: 'Издөө…', zoneNone: 'Мындай район тизмеде жок',
  regionLabel: 'Аймак', otherPlaces: 'Башка жерлер',
  callAgent: 'Чалуу', writeWhatsapp: 'WhatsApp', writeTelegram: 'Telegram',
  confirmedPrice: 'Агент бааны жана жеткиликтүүлүктү ырастады',
  agentLeads: 'Объектти алып баруучу',
  agentYears: (n) => `кыймылсыз мүлктө ${n} жыл`,
  agentRegistry: (no) => `Риэлторлор реестринде: ${no}`,
  agentRegistryNote: 'Номер администратор тарабынан текшерилген',
  agentsNav: 'Агенттер', agentsTitle: 'Объекттерди ким алып барат',
  agentsLede: 'Каталогдогу ар бир объектти келишими бар адам алып барат.',
  agentsEmpty: 'Азырынча эч кимде жарыяланган объект жок.',
  agentObjects: (n) => `каталогдо ${n} объект`,
  agentNotFound: 'Мындай агент сайтта жок',
  toAgents: '← Бардык агенттер', agentOf: 'Агенттин объекттери',
  notFound: 'Барак табылган жок',
  notFoundLede: 'Объект жарыядан алынган же сатылган болушу мүмкүн.',
  seeWhatIsThere: 'Азыр эмне бар экенин көрүү →',
  viewObject: 'Объектти көрүү',
  leadNote: 'Арыз ушул объектти жүргүзгөн агентке барат. Телефонду ал гана көрөт.',
  yourName: 'Атыңыз', phone: 'Телефон',
  phoneNote: 'Ушул номер аркылуу агент байланышат. Башка эч ким көрбөйт.',
  whenConvenient: 'Качан көрүүгө ыңгайлуу', sendRequest: 'Арыз калтыруу',
  sending: 'Жөнөтүлүүдө…', sent: 'Арыз жөнөтүлдү.',
  sentNote: (a) => `«${a}» объектин жүргүзгөн агент калтырылган номерге чалат.`,
  callNow: 'Азыр чалуу', salesDept: 'Liberterra сатуу бөлүмү.',
  errPhone: 'Телефон номерин текшериңиз: ушул номер аркылуу байланышабыз.',
  errName: 'Атыңызды жана билдирүүнү текшериңиз.',
  errMany: 'Бул номерден арыздар өтө көп. Бир сааттан кийин аракет кылыңыз.',
  errGone: 'Бул объект эми сатылбайт.',
  errGeneric: 'Арызды жөнөтүү мүмкүн болгон жок. Кайра аракет кылыңыз.',
  roomsShort: 'бөлмө', sqm: 'м²', floorShort: 'кабат', priceHint: '120 000',
  namePlaceholder: 'Азамат', phonePlaceholder: '+996 700 00 00 00',
  messageLabel: 'Сурооңуз же ыңгайлуу убакыт (милдеттүү эмес)',
  messagePlaceholder: 'Ишембиде күндүз көрсө болобу?', honeypotLabel: 'Сайт',
  siteTitle: 'Бишкектеги кыймылсыз мүлк: ижара жана сатуу',
  siteDescription: 'Liberterra: Бишкектеги батирлер, үйлөр жана коммерциялык мүлк.',
  drawingAlt: 'Сүрөттүн ордуна тартылган сүрөт',
  forAgentsShort: 'Кирүү',
  city: 'Бишкек',
  tabBuy: 'Сатып алуу', tabRent: 'Ижарага алуу',
  moreFilters: 'Кошумча чыпкалар', priceFrom: 'Баасы',
  reqNav: 'Арыздар',
  reqTitle: 'Эмне издеп жатасыз?',
  reqLede: 'Каталогдон туура келгенин таппадыңызбы — эмне керектигин жазыңыз. Арызды агент карап, ачык жарыяланбаганын сунуштайт.',
  reqDeal: 'Сатып алуу же ижара', reqBuy: 'Сатып алуу', reqRent: 'Ижарага алуу',
  reqType: 'Турак жайдын түрү', reqRooms: 'Бөлмө', reqDistrict: 'Район',
  reqDistrictAny: 'Бардык райондор', reqBudget: 'Бюджет',
  reqWishes: 'Эмне маанилүү', reqWishesHint: 'Биринчи кабат керек эмес, лифт жана унаа токтотуучу жай керек',
  reqConsent: 'Арызды алган агентке телефонумду көрсөтүүгө уруксат берем',
  reqConsentHint: 'Болбосо агент издөө шарттарын гана көрөт жана чала албайт.',
  reqSend: 'Арыз жөнөтүү', reqSending: 'Жөнөтүлүүдө…',
  reqSent: 'Арыз кабыл алынды.',
  reqSentNote: 'Агент бир сааттын ичинде байланышат. Эртерээк тапсак — эртерээк чалабыз.',
  reqErrPhone: 'Телефон номерин текшериңиз: ушул номер аркылуу байланышабыз.',
  reqErrInput: 'Толтурулган талааларды текшериңиз.',
  reqErrMany: 'Бул номерден бүгүн бир нече арыз келди. Бизге түз чалыңыз.',
  reqErrGeneric: 'Арызды жөнөтүү мүмкүн болгон жок. Кайра аракет кылыңыз.',
  reqWhy1: 'Бир сааттын ичинде жооп беребиз',
  reqWhy2: 'Ачык каталогдо жоктурун көрсөтөбүз',
  reqWhy3: 'Телефонуңузду бир агент гана көрөт',
  pitchEyebrow: 'Ылайыктуусун таппадыңызбы?',
  pitchTitle: 'Эмне издеп жатканыңызды жазыңыз — агенттер издеп беришет',
  pitchLede: 'Каталогдо ырасталган жана бош объекттер гана бар. Калганын агенттер билет, бирок жарыялабайт: ээси сураган, объект даярдалып жатат, баа талкууланууда. Арыз ошол катмарды ачат.',
  pitchButton: 'Арыз калтыруу',
  pitchStep1: 'Эмне керектигин жазасыз', pitchStep1Note: 'Эки мүнөт, телефон гана милдеттүү',
  pitchStep2: 'Арызды агенттер көрөт', pitchStep2Note: 'Бир сааттын ичинде жооп беребиз — бул норматив',
  pitchStep3: 'Сизге варианттар келет', pitchStep3Note: 'Кийин пайда болсо — чалабыз, арыз иште калат',
  themeSwitch: 'Жарык же караңгы тема',
  kinds: { flat: 'батир', room: 'бөлмө', house: 'үй', townhouse: 'таунхаус',
           land: 'жер тилкеси', commercial: 'коммерциялык', garage: 'гараж' },
};

const en: Dict = {
  forAgents: 'Agent login', agency: 'Liberterra', phones: 'Phones',
  sections: 'Sections', agencyLine: (place) => `Real estate agency, ${place}`,
  country: 'Kyrgyzstan',
  cabinetLine: 'The agent cabinet and CRM are behind the agent login.',
  heroTitle: 'Find your space for comfortable', heroEm: 'living and work',
  address: 'Address or district', addressHint: 'Chuy, Asanbay, Jal…',
  deal: 'Deal', anyDeal: 'Any', sale: 'For sale', rent: 'For rent',
  kind: 'Type', anyKind: 'Any', rooms: 'Rooms', anyRooms: 'Any',
  priceTo: 'Price up to', search: 'Show', searchCount: (n) => `Show ${n}`,
  reset: 'clear',
  forSale: 'For sale', forRent: 'For rent',
  sortFresh: 'Recently confirmed', sortCheap: 'Lowest price', sortBig: 'Largest area',
  nothingFound: 'Nothing matched these filters. Try widening the search — for example, remove the price limit.',
  nothingYet: 'No published listings yet.',
  catalogDown: 'the catalogue is temporarily unavailable',
  pageOf: (c, n) => `page ${c} of ${n}`, back: '← back', forward: 'next →',
  perMonth: ' / month', confirmedBy: 'Agent confirmed',
  today: 'today', yesterday: 'yesterday',
  daysAgo: (n) => `${n} ${n === 1 ? 'day' : 'days'} ago`,
  objectsCount: (n) => `${n} ${n === 1 ? 'listing' : 'listings'}`,
  toAll: '← All listings', about: 'About this property', published: 'Published',
  roomsLabel: 'Rooms', areaLabel: 'Area', floorLabel: 'Floor', floorOf: 'of',
  zoneLabel: 'District', cityLabel: 'City',
  zoneSearch: 'Search…', zoneNone: 'No such district in the list',
  regionLabel: 'Region', otherPlaces: 'Other places',
  callAgent: 'Call', writeWhatsapp: 'WhatsApp', writeTelegram: 'Telegram',
  confirmedPrice: 'Agent confirmed the price and availability',
  agentLeads: 'Listing agent',
  agentYears: (n) => `${n} ${n === 1 ? 'year' : 'years'} in real estate`,
  agentRegistry: (no) => `Realtor registry no.: ${no}`,
  agentRegistryNote: 'Verified by the administrator',
  agentsNav: 'Agents', agentsTitle: 'Who handles the listings',
  agentsLede: 'Every listing in the catalogue is handled by a person with a contract.',
  agentsEmpty: 'No one has published listings yet.',
  agentObjects: (n) => `${n} ${n === 1 ? 'listing' : 'listings'} in the catalogue`,
  agentNotFound: 'No such agent on this site',
  toAgents: '← All agents', agentOf: 'Listings of this agent',
  notFound: 'Page not found',
  notFoundLede: 'The listing may have been withdrawn or sold.',
  seeWhatIsThere: 'See what is available now →',
  viewObject: 'Book a viewing',
  leadNote: 'Your request goes to the agent handling this property. Only they see your phone number.',
  yourName: 'Your name', phone: 'Phone',
  phoneNote: 'The agent will call you on this number. Nobody else sees it.',
  whenConvenient: 'When it suits you', sendRequest: 'Send request',
  sending: 'Sending…', sent: 'Request sent.',
  sentNote: (a) => `The agent handling ${a} will call you on the number you left.`,
  callNow: 'Call now', salesDept: 'Liberterra sales desk.',
  errPhone: 'Check the phone number — the agent will call you on it.',
  errName: 'Check your name and message.',
  errMany: 'Too many requests from this number right now. Please try again in an hour.',
  errGone: 'This property is no longer available.',
  errGeneric: 'The request could not be sent. Please try again.',
  roomsShort: 'rooms', sqm: 'm²', floorShort: 'floor', priceHint: '120,000',
  namePlaceholder: 'Azamat', phonePlaceholder: '+996 700 00 00 00',
  messageLabel: 'Question or a convenient time (optional)',
  messagePlaceholder: 'Could I see it on Saturday afternoon?', honeypotLabel: 'Website',
  siteTitle: 'Real estate in Bishkek: for sale and for rent',
  siteDescription: 'Liberterra: flats, houses and commercial property in Bishkek.',
  drawingAlt: 'Drawing shown instead of a photo',
  forAgentsShort: 'Log in',
  city: 'Bishkek',
  tabBuy: 'Buy', tabRent: 'Rent',
  moreFilters: 'More filters', priceFrom: 'Price from',
  reqNav: 'Requests',
  reqTitle: 'What are you looking for?',
  reqLede: 'Nothing in the catalogue fits? Tell us what you need. An agent will take it up and show you what is not listed publicly yet.',
  reqDeal: 'Buy or rent', reqBuy: 'Buy', reqRent: 'Rent',
  reqType: 'Property type', reqRooms: 'Rooms', reqDistrict: 'District',
  reqDistrictAny: 'Any district', reqBudget: 'Budget up to',
  reqWishes: 'What matters', reqWishesHint: 'Not the ground floor; a lift and parking are a must',
  reqConsent: 'I allow my phone number to be shown to the agent who takes this request',
  reqConsentHint: 'Without it the agent sees only the search parameters and cannot call you.',
  reqSend: 'Send request', reqSending: 'Sending…',
  reqSent: 'Request received.',
  reqSentNote: 'An agent will contact you within the hour. If we find something sooner, we call sooner.',
  reqErrPhone: 'Check the phone number — the agent will call you on it.',
  reqErrInput: 'Please check the fields you filled in.',
  reqErrMany: 'Several requests from this number today already. Please call us directly.',
  reqErrGeneric: 'The request could not be sent. Please try again.',
  reqWhy1: 'We answer within the hour',
  reqWhy2: 'We show what is not publicly listed yet',
  reqWhy3: 'One agent sees your number, not the whole market',
  pitchEyebrow: 'Nothing fits?',
  pitchTitle: 'Describe what you need — agents do the searching',
  pitchLede: 'The catalogue holds only what is confirmed and available. Agents know the rest but do not publish it: the owner asked them not to, the place is still being prepared, the price is under discussion. A request opens that layer to you.',
  pitchButton: 'Send a request',
  pitchStep1: 'You describe what you need', pitchStep1Note: 'Two minutes; only the phone number is required',
  pitchStep2: 'Agents see the request', pitchStep2Note: 'We answer within the hour — a standard, not a promise',
  pitchStep3: 'They bring you options', pitchStep3Note: 'If it appears later, we call: the request stays open',
  themeSwitch: 'Light or dark theme',
  kinds: { flat: 'flat', room: 'room', house: 'house', townhouse: 'townhouse',
           land: 'land', commercial: 'commercial', garage: 'garage' },
};

const zh: Dict = {
  forAgents: '经纪人登录', agency: 'Liberterra', phones: '电话',
  sections: '栏目', agencyLine: (place) => `${place}房地产中介`,
  country: '吉尔吉斯斯坦',
  cabinetLine: '经纪人工作台与 CRM 需登录后使用。',
  heroTitle: '找到适合您的', heroEm: '居住与工作空间',
  address: '地址或区域', addressHint: '楚河、阿桑拜、扎尔…',
  deal: '交易', anyDeal: '不限', sale: '出售', rent: '出租',
  kind: '类型', anyKind: '不限', rooms: '房间数', anyRooms: '不限',
  priceTo: '价格上限', search: '查找', searchCount: (n) => `查找 ${n} 套`,
  reset: '清除',
  forSale: '出售', forRent: '出租',
  sortFresh: '最近确认优先', sortCheap: '价格从低到高', sortBig: '面积从大到小',
  nothingFound: '没有符合条件的房源。可以放宽筛选，例如取消价格上限。',
  nothingYet: '暂无已发布的房源。',
  catalogDown: '目录暂时无法访问',
  pageOf: (c, n) => `第 ${c} 页 / 共 ${n} 页`, back: '← 上一页', forward: '下一页 →',
  perMonth: ' / 月', confirmedBy: '经纪人确认于',
  today: '今天', yesterday: '昨天',
  daysAgo: (n) => `${n} 天前`,
  objectsCount: (n) => `${n} 套房源`,
  toAll: '← 返回全部房源', about: '房源介绍', published: '发布时间',
  roomsLabel: '房间数', areaLabel: '面积', floorLabel: '楼层', floorOf: '/',
  zoneLabel: '区域', cityLabel: '城市',
  zoneSearch: '搜索…', zoneNone: '列表中没有该区域',
  regionLabel: '地区', otherPlaces: '其他地方',
  callAgent: '拨打电话', writeWhatsapp: 'WhatsApp', writeTelegram: 'Telegram',
  confirmedPrice: '经纪人已确认价格与可售状态',
  agentLeads: '负责经纪人',
  agentYears: (n) => `从事房地产 ${n} 年`,
  agentRegistry: (no) => `房地产经纪人登记号：${no}`,
  agentRegistryNote: '已由管理员核验',
  agentsNav: '经纪人', agentsTitle: '谁在负责这些房源',
  agentsLede: '目录中的每套房源都由持有委托合同的经纪人负责。',
  agentsEmpty: '目前还没有人发布房源。',
  agentObjects: (n) => `目录中有 ${n} 套房源`,
  agentNotFound: '本站没有这位经纪人',
  toAgents: '← 全部经纪人', agentOf: '该经纪人的房源',
  notFound: '页面未找到',
  notFoundLede: '该房源可能已下架或已售出。',
  seeWhatIsThere: '看看现在有哪些房源 →',
  viewObject: '预约看房',
  leadNote: '您的请求将发送给负责该房源的经纪人，只有他能看到您的电话。',
  yourName: '您的称呼', phone: '电话',
  phoneNote: '经纪人将拨打此号码与您联系，其他人看不到。',
  whenConvenient: '方便看房的时间', sendRequest: '提交请求',
  sending: '提交中…', sent: '请求已提交。',
  sentNote: (a) => `负责「${a}」的经纪人会拨打您留下的号码。`,
  callNow: '立即致电', salesDept: 'Liberterra 销售部。',
  errPhone: '请检查电话号码，经纪人将拨打此号码。',
  errName: '请检查姓名和留言。',
  errMany: '该号码的请求过多，请一小时后再试。',
  errGone: '该房源已不可用。',
  errGeneric: '请求发送失败，请重试。',
  roomsShort: '室', sqm: '平米', floorShort: '层', priceHint: '120 000',
  namePlaceholder: '您的称呼', phonePlaceholder: '+996 700 00 00 00',
  messageLabel: '问题或方便的时间（可选）',
  messagePlaceholder: '周六下午可以看房吗？', honeypotLabel: '网站',
  siteTitle: '比什凯克房产：出售与出租',
  siteDescription: 'Liberterra：比什凯克的公寓、住宅与商业地产。',
  drawingAlt: '以插图代替照片',
  forAgentsShort: '登录',
  city: '比什凯克',
  tabBuy: '购买', tabRent: '租赁',
  moreFilters: '更多筛选', priceFrom: '价格下限',
  reqNav: '需求登记',
  reqTitle: '您在找什么样的房子？',
  reqLede: '目录里没有合适的？写下您的需求。经纪人会跟进，并为您提供尚未公开发布的房源。',
  reqDeal: '购买或租赁', reqBuy: '购买', reqRent: '租赁',
  reqType: '房屋类型', reqRooms: '房间数', reqDistrict: '区域',
  reqDistrictAny: '不限区域', reqBudget: '预算上限',
  reqWishes: '您的要求', reqWishesHint: '不要一楼，需要电梯和车位',
  reqConsent: '同意将我的电话提供给承接此需求的经纪人',
  reqConsentHint: '不同意时，经纪人只能看到搜索条件，无法与您联系。',
  reqSend: '提交需求', reqSending: '提交中…',
  reqSent: '需求已收到。',
  reqSentNote: '经纪人将在一小时内与您联系；若更早找到合适房源，会更早致电。',
  reqErrPhone: '请检查电话号码，经纪人将拨打此号码。',
  reqErrInput: '请检查已填写的内容。',
  reqErrMany: '该号码今天已提交多次。请直接致电我们。',
  reqErrGeneric: '提交失败，请重试。',
  reqWhy1: '一小时内回复',
  reqWhy2: '提供尚未公开的房源',
  reqWhy3: '只有一位经纪人能看到您的号码',
  pitchEyebrow: '没有合适的？',
  pitchTitle: '写下您的需求 — 由经纪人去找',
  pitchLede: '目录里只有已确认且可售的房源。其余的经纪人知道，但不公开：业主要求不发布、房子仍在准备、价格尚在商议。提交需求即可进入这一层。',
  pitchButton: '提交需求',
  pitchStep1: '您写下需求', pitchStep1Note: '两分钟，仅电话为必填',
  pitchStep2: '经纪人看到需求', pitchStep2Note: '一小时内回复 — 这是标准，不是口号',
  pitchStep3: '他们为您带来房源', pitchStep3Note: '日后出现也会致电：需求一直有效',
  themeSwitch: '浅色或深色主题',
  kinds: { flat: '公寓', room: '单间', house: '独栋', townhouse: '联排别墅',
           land: '地块', commercial: '商业用房', garage: '车库' },
};

const DICTS: Record<Lang, Dict> = { ky, ru, en, zh };

export const t = (lang: Lang): Dict => DICTS[lang] ?? DICTS[DEFAULT_LANG];

/** Тип недвижимости на выбранном языке. */
export const kindName = (lang: Lang, kind: string) => t(lang).kinds[kind] ?? kind;

/** Срок последнего подтверждения словами. */
export function freshWordIn(lang: Lang, days: number): string {
  const d = t(lang);
  if (days === 0) return d.today;
  if (days === 1) return d.yesterday;
  return d.daysAgo(days);
}

/**
 * Что писать вместо города: сам город или страну.
 *
 * Пока все объекты в одном городе, привязка к нему работает на доверие:
 * местное агентство человек выбирает именно как местное. Появятся объекты
 * в других городах — «Бишкек» в подвале станет неправдой, и вместо него
 * встанет страна.
 *
 * Считается по каталогу, а не правится руками: иначе этот текст устареет
 * ровно в тот день, когда кто-то заведёт объект в Оше, и никто об этом не
 * вспомнит.
 *
 * Пустой каталог — город по умолчанию: сайт без объектов всё равно
 * бишкекский, и говорить «Кыргызстан» не о чем.
 */
export function placeName(cities: string[], d: Dict): string {
  if (cities.length > 1) return d.country;
  return cities[0] ?? d.city;
}
