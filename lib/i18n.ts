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
  forAgents: string; forAgentsShort: string; agency: string; city: string; phones: string; sections: string;
  agencyLine: string; cabinetLine: string;
  // Герой
  heroTitle: string; heroEm: string; heroLede: string;
  prop1: string; prop2: string; prop3: string;
  // Поиск
  address: string; addressHint: string; deal: string; anyDeal: string;
  sale: string; rent: string; kind: string; anyKind: string;
  rooms: string; anyRooms: string; priceTo: string; search: string; reset: string;
  // Выдача
  forSaleAndRent: string; forSale: string; forRent: string;
  sortFresh: string; sortCheap: string; sortBig: string;
  nothingFound: string; nothingYet: string; catalogDown: string;
  pageOf: (cur: number, total: number) => string;
  back: string; forward: string;
  // Карточка
  perMonth: string; confirmed: string; confirmedBy: string;
  today: string; yesterday: string; daysAgo: (n: number) => string;
  objectsCount: (n: number) => string;
  // Страница объекта
  toAll: string; about: string; published: string; roomsLabel: string;
  areaLabel: string; floorLabel: string; floorOf: string; zoneLabel: string;
  confirmedPrice: string; notFound: string; notFoundLede: string; seeWhatIsThere: string;
  // Заявка
  viewObject: string; leadNote: string; yourName: string; phone: string;
  phoneNote: string; whenConvenient: string; sendRequest: string; sending: string;
  sent: string; sentNote: (address: string) => string; callNow: string; salesDept: string;
  errPhone: string; errName: string; errMany: string; errGone: string; errGeneric: string;
  // Мелкие подписи и подсказки в полях
  roomsShort: string; sqm: string; floorShort: string; priceHint: string;
  namePlaceholder: string; phonePlaceholder: string;
  messageLabel: string; messagePlaceholder: string; honeypotLabel: string;
  siteTitle: string; siteDescription: string; drawingAlt: string;
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
  sections: 'Разделы', agencyLine: 'Агентство недвижимости, Бишкек',
  cabinetLine: 'Кабинет и CRM — по входу для агентов.',
  heroTitle: 'Квартиры, дома и участки', heroEm: 'в Бишкеке',
  heroLede: 'Каждое объявление ведёт агент Liberterra: цену и доступность он подтверждает лично, а дата на карточке показывает, когда это было в последний раз.',
  prop1: 'Цену подтверждают, а не копируют',
  prop2: 'Один объект — один ответственный агент',
  prop3: 'Телефон собственника закрыт',
  address: 'Адрес или район', addressHint: 'Чүй, Асанбай, Джал…',
  deal: 'Сделка', anyDeal: 'Любая', sale: 'Продажа', rent: 'Аренда',
  kind: 'Тип', anyKind: 'Любой', rooms: 'Комнат', anyRooms: 'Любое',
  priceTo: 'Цена до', search: 'Показать', reset: 'сбросить',
  forSaleAndRent: 'В продаже и аренде', forSale: 'В продаже', forRent: 'В аренде',
  sortFresh: 'Сначала свежие', sortCheap: 'Дешевле', sortBig: 'Больше площади',
  nothingFound: 'Под эти условия ничего не подошло. Попробуйте расширить поиск — например, убрать ограничение по цене.',
  nothingYet: 'Пока нет опубликованных объектов.',
  catalogDown: 'каталог временно недоступен',
  pageOf: (c, n) => `страница ${c} из ${n}`, back: '← назад', forward: 'вперёд →',
  perMonth: ' / мес.', confirmed: 'Подтверждён', confirmedBy: 'Агент подтвердил',
  today: 'сегодня', yesterday: 'вчера',
  daysAgo: (n) => `${n} ${plural(n, 'день', 'дня', 'дней')} назад`,
  objectsCount: (n) => `${n} ${plural(n, 'объект', 'объекта', 'объектов')}`,
  toAll: '← Ко всем объектам', about: 'Об объекте', published: 'Опубликован',
  roomsLabel: 'Комнат', areaLabel: 'Площадь', floorLabel: 'Этаж', floorOf: 'из',
  zoneLabel: 'Район', confirmedPrice: 'Агент подтвердил цену и доступность',
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
  siteTitle: 'Недвижимость в Бишкеке: аренда и продажа — Liberterra',
  siteDescription: 'Liberterra: квартиры, дома и коммерческая недвижимость в Бишкеке.',
  drawingAlt: 'Рисунок вместо фотографии',
  forAgentsShort: 'Вход',
  city: 'Бишкек',
  kinds: { flat: 'квартира', room: 'комната', house: 'дом', townhouse: 'таунхаус',
           land: 'участок', commercial: 'коммерческая', garage: 'гараж' },
};

const ky: Dict = {
  forAgents: 'Агенттер үчүн кирүү', agency: 'Liberterra', phones: 'Телефондор',
  sections: 'Бөлүмдөр', agencyLine: 'Кыймылсыз мүлк агенттиги, Бишкек',
  cabinetLine: 'Кабинет жана CRM — агенттер үчүн кирүү аркылуу.',
  heroTitle: 'Батирлер, үйлөр жана жер тилкелери', heroEm: 'Бишкекте',
  heroLede: 'Ар бир жарнаманы Liberterra агенти жүргүзөт: бааны жана жеткиликтүүлүктү өзү ырастайт, картадагы күн акыркы ырастоо качан болгонун көрсөтөт.',
  prop1: 'Баа көчүрүлбөйт, ырасталат',
  prop2: 'Бир объект — бир жооптуу агент',
  prop3: 'Ээсинин телефону жабык',
  address: 'Дарек же район', addressHint: 'Чүй, Асанбай, Жал…',
  deal: 'Бүтүм', anyDeal: 'Баары', sale: 'Сатуу', rent: 'Ижара',
  kind: 'Түрү', anyKind: 'Баары', rooms: 'Бөлмө', anyRooms: 'Баары',
  priceTo: 'Баасы чейин', search: 'Көрсөтүү', reset: 'тазалоо',
  forSaleAndRent: 'Сатууда жана ижарада', forSale: 'Сатууда', forRent: 'Ижарада',
  sortFresh: 'Жаңылары биринчи', sortCheap: 'Арзаныраак', sortBig: 'Аянты чоңураак',
  nothingFound: 'Бул шарттарга эч нерсе туура келген жок. Издөөнү кеңейтип көрүңүз — мисалы, баа чегин алып салыңыз.',
  nothingYet: 'Азырынча жарыяланган объекттер жок.',
  catalogDown: 'каталог убактылуу жеткиликсиз',
  pageOf: (c, n) => `${n} барактын ${c}-си`, back: '← артка', forward: 'алга →',
  perMonth: ' / айына', confirmed: 'Ырасталган', confirmedBy: 'Агент ырастады',
  today: 'бүгүн', yesterday: 'кечээ',
  daysAgo: (n) => `${n} күн мурун`,
  objectsCount: (n) => `${n} объект`,
  toAll: '← Бардык объекттерге', about: 'Объект жөнүндө', published: 'Жарыяланган',
  roomsLabel: 'Бөлмө', areaLabel: 'Аянты', floorLabel: 'Кабат', floorOf: '/',
  zoneLabel: 'Район', confirmedPrice: 'Агент бааны жана жеткиликтүүлүктү ырастады',
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
  siteTitle: 'Бишкектеги кыймылсыз мүлк: ижара жана сатуу — Liberterra',
  siteDescription: 'Liberterra: Бишкектеги батирлер, үйлөр жана коммерциялык мүлк.',
  drawingAlt: 'Сүрөттүн ордуна тартылган сүрөт',
  forAgentsShort: 'Кирүү',
  city: 'Бишкек',
  kinds: { flat: 'батир', room: 'бөлмө', house: 'үй', townhouse: 'таунхаус',
           land: 'жер тилкеси', commercial: 'коммерциялык', garage: 'гараж' },
};

const en: Dict = {
  forAgents: 'Agent login', agency: 'Liberterra', phones: 'Phones',
  sections: 'Sections', agencyLine: 'Real estate agency, Bishkek',
  cabinetLine: 'The agent cabinet and CRM are behind the agent login.',
  heroTitle: 'Flats, houses and land', heroEm: 'in Bishkek',
  heroLede: 'Every listing is handled by a Liberterra agent who confirms the price and availability in person. The date on each card shows when that last happened.',
  prop1: 'Prices are confirmed, not copied',
  prop2: 'One property, one responsible agent',
  prop3: "The owner's phone number stays private",
  address: 'Address or district', addressHint: 'Chuy, Asanbay, Jal…',
  deal: 'Deal', anyDeal: 'Any', sale: 'For sale', rent: 'For rent',
  kind: 'Type', anyKind: 'Any', rooms: 'Rooms', anyRooms: 'Any',
  priceTo: 'Price up to', search: 'Show', reset: 'clear',
  forSaleAndRent: 'For sale and rent', forSale: 'For sale', forRent: 'For rent',
  sortFresh: 'Recently confirmed', sortCheap: 'Lowest price', sortBig: 'Largest area',
  nothingFound: 'Nothing matched these filters. Try widening the search — for example, remove the price limit.',
  nothingYet: 'No published listings yet.',
  catalogDown: 'the catalogue is temporarily unavailable',
  pageOf: (c, n) => `page ${c} of ${n}`, back: '← back', forward: 'next →',
  perMonth: ' / month', confirmed: 'Confirmed', confirmedBy: 'Agent confirmed',
  today: 'today', yesterday: 'yesterday',
  daysAgo: (n) => `${n} ${n === 1 ? 'day' : 'days'} ago`,
  objectsCount: (n) => `${n} ${n === 1 ? 'listing' : 'listings'}`,
  toAll: '← All listings', about: 'About this property', published: 'Published',
  roomsLabel: 'Rooms', areaLabel: 'Area', floorLabel: 'Floor', floorOf: 'of',
  zoneLabel: 'District', confirmedPrice: 'Agent confirmed the price and availability',
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
  siteTitle: 'Real estate in Bishkek: for sale and for rent — Liberterra',
  siteDescription: 'Liberterra: flats, houses and commercial property in Bishkek.',
  drawingAlt: 'Drawing shown instead of a photo',
  forAgentsShort: 'Log in',
  city: 'Bishkek',
  kinds: { flat: 'flat', room: 'room', house: 'house', townhouse: 'townhouse',
           land: 'land', commercial: 'commercial', garage: 'garage' },
};

const zh: Dict = {
  forAgents: '经纪人登录', agency: 'Liberterra', phones: '电话',
  sections: '栏目', agencyLine: '比什凯克房地产中介',
  cabinetLine: '经纪人工作台与 CRM 需登录后使用。',
  heroTitle: '比什凯克的', heroEm: '公寓、住宅与地块',
  heroLede: '每一条房源都由 Liberterra 的经纪人负责，价格与可售状态由本人确认。卡片上的日期显示最近一次确认的时间。',
  prop1: '价格经过确认，不是照搬',
  prop2: '一套房源，一位负责经纪人',
  prop3: '业主电话不对外公开',
  address: '地址或区域', addressHint: '楚河、阿桑拜、扎尔…',
  deal: '交易', anyDeal: '不限', sale: '出售', rent: '出租',
  kind: '类型', anyKind: '不限', rooms: '房间数', anyRooms: '不限',
  priceTo: '价格上限', search: '查找', reset: '清除',
  forSaleAndRent: '出售与出租', forSale: '出售', forRent: '出租',
  sortFresh: '最近确认优先', sortCheap: '价格从低到高', sortBig: '面积从大到小',
  nothingFound: '没有符合条件的房源。可以放宽筛选，例如取消价格上限。',
  nothingYet: '暂无已发布的房源。',
  catalogDown: '目录暂时无法访问',
  pageOf: (c, n) => `第 ${c} 页 / 共 ${n} 页`, back: '← 上一页', forward: '下一页 →',
  perMonth: ' / 月', confirmed: '已确认', confirmedBy: '经纪人确认于',
  today: '今天', yesterday: '昨天',
  daysAgo: (n) => `${n} 天前`,
  objectsCount: (n) => `${n} 套房源`,
  toAll: '← 返回全部房源', about: '房源介绍', published: '发布时间',
  roomsLabel: '房间数', areaLabel: '面积', floorLabel: '楼层', floorOf: '/',
  zoneLabel: '区域', confirmedPrice: '经纪人已确认价格与可售状态',
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
  siteTitle: '比什凯克房产：出售与出租 — Liberterra',
  siteDescription: 'Liberterra：比什凯克的公寓、住宅与商业地产。',
  drawingAlt: '以插图代替照片',
  forAgentsShort: '登录',
  city: '比什凯克',
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
