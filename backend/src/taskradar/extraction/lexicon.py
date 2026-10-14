"""Multilingual (zh / de / en) lexicon used by the rule engine and the reconciler.

Kept as data so it can be reviewed and extended without touching the algorithms.
"""

from __future__ import annotations

import re

from taskradar.domain.enums import ActionType, Category, CompletionKind


def _rx(*parts: str, flags: int = re.I) -> re.Pattern[str]:
    return re.compile("|".join(parts), flags)


# ---------------------------------------------------------------------------------------------
# Actions (verb -> canonical action type)
# ---------------------------------------------------------------------------------------------

ACTION_PATTERNS: list[tuple[ActionType, re.Pattern[str]]] = [
    (ActionType.UPLOAD, _rx(r"上传", r"\bupload\w*", r"hochladen|hochzuladen|laden\s+Sie\b.{0,200}?\bhoch\b")),
    (
        ActionType.PAY,
        _rx(
            r"缴纳|缴费|缴清|交费|支付|付款|付清|汇款|转账|续费",
            r"\bpay\b|\bpaying\b|\btransfer\b|\bremit\b|\bsettle\b|payment (?:is )?due",
            r"bezahlen|zahlen|überweisen|begleichen|entrichten|zahlbar",
        ),
    ),
    (
        ActionType.REGISTER,
        _rx(
            r"报名|注册|登记|选课|申报|报到",
            r"\bregister\w*|\benrol+\w*|\bsign up\b|\bre-?register\w*",
            r"anmelden|anzumelden|melden\s+Sie\s+sich\b.{0,200}?\ban\b|registrieren|einschreiben|zurückmelden|"
            r"zurückzumelden|immatrikulieren",
        ),
    ),
    (
        ActionType.SUBMIT,
        _rx(
            r"提交|递交|呈交|上交|交回|寄送|寄回|补交|补充提交|提供",
            r"\bsubmit\w*|\bhand in\b|\bturn in\b|\bsend (?:us|in|back)\b|\bprovide\b|\breturn (?:the|your)\b",
            r"einreichen|einzureichen|reichen\s+Sie\b.{0,200}?\bein\b|abgeben|abzugeben|geben\s+Sie\b.{0,200}?\bab\b|"
            r"vorlegen|vorzulegen|legen\s+Sie\b.{0,200}?\bvor\b|nachreichen|nachzureichen|zusenden|zuzusenden|"
            r"zukommen (?:zu )?lassen|übermitteln|einsenden|einzusenden|senden\s+Sie|schicken\s+Sie|"
            r"zurückschicken|zurückzuschicken|zurücksenden|zurückzusenden|zuschicken|zuzuschicken",
        ),
    ),
    (
        ActionType.REPLY,
        _rx(
            r"回复|答复|回信|反馈",
            r"\breply\b|\brespond\b|\bget back to\b|\blet us know\b|\banswer\b",
            r"antworten|beantworten|rückmelden|melden\s+Sie\s+sich|Rückantwort|teilen\s+Sie\s+uns\b.{0,40}?\bmit\b",
        ),
    ),
    (ActionType.CONFIRM, _rx(r"确认", r"\bconfirm\w*|\bverify\b|\backnowledge\b", r"bestätigen")),
    (ActionType.SIGN, _rx(r"签署|签字|签名|签订", r"\bsign\b|\bcountersign\b", r"unterschreiben|unterzeichnen")),
    (ActionType.RENEW, _rx(r"续签|续期|延长签证", r"\brenew\w*|\bextend your\b", r"verlängern|erneuern")),
    (ActionType.APPLY, _rx(r"申请|办理", r"\bapply\b|\bapply for\b", r"beantragen|bewerben\s+Sie|Antrag stellen")),
    (ActionType.BOOK, _rx(r"预约|预订", r"\bbook\b|\bschedule\b|\breserve\b|make an appointment", r"buchen|vereinbaren|reservieren")),
    (ActionType.ATTEND, _rx(r"参加|出席|到场", r"\battend\b|\bjoin\b|\bparticipate\b|\bbe present\b", r"teilnehmen|erscheinen\s+Sie|besuchen\s+Sie")),
    (ActionType.BRING, _rx(r"携带|带上|带好", r"\bbring\b|\bcarry\b", r"mitbringen|mitzubringen|bringen\s+Sie\b.{0,200}?\bmit\b")),
    (
        ActionType.PREPARE,
        _rx(
            r"填写|填报|完成|准备|更新",
            r"\bcomplete\b|\bfill (?:in|out)\b|\bprepare\b|\bupdate\b",
            r"ausfüllen|auszufüllen|füllen\s+Sie\b.{0,200}?\baus\b|erledigen|zu erledigen|vorbereiten|aktualisieren",
        ),
    ),
]

# Words that make a sentence an obligation addressed to the reader.
OBLIGATION_CUES = _rx(
    r"请|务必|需要|需|须|必须|应当|要求|记得|别忘了|敬请|烦请|麻烦您",
    r"\bplease\b|\bkindly\b|\bmust\b|\brequired\b|\bneed(?:s)? to\b|\bha(?:ve|s) to\b|\bare asked to\b|"
    r"\byou should\b|\bremember to\b|\bdon'?t forget\b|\bdo not forget\b|action required|mandatory",
    r"\bbitte\b|\bmüssen\b|\bmuss\b|verpflichtet|erforderlich|benötigen|denken Sie daran|vergessen Sie nicht|"
    r"notwendig|wir bitten Sie|sind gebeten",
)

ADDRESSEE_CUES = _rx(r"您|你", r"\byou\b|\byour\b", r"\bSie\b|\bIhre?[nmrs]?\b", flags=0)

# Statements that describe what someone else will do; not obligations for the user.
THIRD_PARTY_CUES = _rx(r"我们将|我们会|we will|we'll|wir werden|wird von uns")

OPTIONAL_CUES = _rx(r"可选|自愿|如有兴趣|如有需要", r"\boptional\b|if you wish|if you are interested", r"freiwillig|bei Interesse|optional")

CONSEQUENCE_CUES = _rx(
    r"罚款|滞纳金|否则|将被|取消资格|注销|逾期将|影响注册|无法注册",
    r"late fee|penalty|otherwise|will be (?:cancel+ed|deregistered|exmatriculated|removed)|fine of",
    r"Mahnung|Säumnis|Exmatrikulation|exmatrikuliert|andernfalls|ansonsten|Bußgeld|Mahngebühr",
)

MARKETING_STRONG = _rx(
    r"退订|取消订阅|优惠|折扣|促销|限时|特价|抢购|满减|领券|立即购买|会员日|秒杀|包邮",
    r"unsubscribe|\d+\s?% off|\bsale\b|discount|promo(?:tion)? code|coupon|shop now|buy now|limited time|"
    r"free trial|black friday|cyber monday|exclusive offer|deal of the day|view (?:this email )?in (?:your )?browser",
    r"abbestellen|vom Newsletter abmelden|Rabatt|Gutschein|Sonderangebot|jetzt kaufen|jetzt shoppen|"
    r"im Browser anzeigen|Angebot gilt",
)

NEWSLETTER_CUES = _rx(r"简报|周报|资讯|新闻", r"\bnewsletter\b|\bdigest\b|weekly update|news roundup", r"Newsletter|Wochenrückblick|Neuigkeiten")

REMINDER_CUES = _rx(
    r"提醒|再次提醒|温馨提示|友情提示|催办|尚未收到|还未收到|仍未",
    r"\breminder\b|friendly reminder|kind reminder|gentle reminder|this is a reminder|we have not (?:yet )?received|still need",
    r"Erinnerung|erinnern|Zahlungserinnerung|Mahnung|noch nicht erhalten|liegt uns noch nicht vor|noch ausstehend",
)

DEADLINE_CHANGE_CUES = _rx(
    r"延期|延长至|延长到|推迟至|推迟到|改为|调整为|变更为|新的截止",
    r"\bextended\b|\bpostponed\b|new deadline|moved to|changed to|rescheduled",
    r"verlängert|verschoben|neue Frist|neuer Termin|geändert auf",
)

CANCEL_TASK_CUES = _rx(r"无需再|不再需要|无需提交", r"no longer (?:required|necessary|needed)", r"nicht mehr erforderlich|entfällt")

# "If you have already submitted ..., please ignore" -> a reminder, NOT a completion.
CONDITIONAL_DONE = _rx(
    r"(?:如果|如|若)(?:您|你)?已(?:经)?.{0,30}?(?:请忽略|无需|可忽略|请勿理会)",
    r"if you (?:have|'ve) already.{0,80}?(?:ignore|disregard)",
    r"(?:falls|sofern|wenn) Sie .{0,80}?bereits.{0,80}?(?:betrachten Sie|ignorieren|gegenstandslos)",
)

NEGATED_DONE = _rx(
    r"尚未收到|还未收到|仍未收到|没有收到|未收到",
    r"(?:have|has) not (?:yet )?(?:been )?received|haven't received|not yet received",
    r"noch nicht (?:erhalten|eingegangen)|liegt uns noch nicht vor|nicht erhalten",
)

UNCERTAIN_CUES = _rx(
    r"似乎|可能|好像|部分|待核实|需核实|仍需核实|暂时",
    r"\bmay have\b|\bmight\b|\bseems?\b|\bappears?\b|\bpartial\w*|pending verification|we will (?:check|verify|review)",
    r"möglicherweise|scheinbar|teilweise|vorläufig|wir prüfen|noch geprüft",
)

COMPLETION_PATTERNS: list[tuple[CompletionKind, re.Pattern[str]]] = [
    (
        CompletionKind.PAID,
        _rx(
            r"已缴费|缴费成功|支付成功|付款成功|已付款|已到账|已收到您的(?:付款|缴费|汇款)",
            r"payment (?:has been |was )?(?:received|successful|confirmed)|thank you for your payment|paid in full",
            r"Zahlung (?:ist )?(?:eingegangen|erhalten)|vielen Dank für Ihre Zahlung|Betrag (?:ist )?eingegangen",
        ),
    ),
    (
        CompletionKind.RECEIVED,
        _rx(
            r"已收到|已经收到|已接收|已确认收到|收到了您的|收到您的",
            r"(?:we have|we've) received|(?:has|have) been received|receipt of your|we confirm receipt|we received your",
            r"(?:haben|hat)\s.{0,60}?(?:erhalten|bekommen)|ist (?:bei uns )?eingegangen|sind (?:bei uns )?eingegangen|"
            r"bestätigen (?:wir )?den Eingang|Eingangsbestätigung",
        ),
    ),
    (
        CompletionKind.COMPLETED,
        _rx(
            r"已完成|已办理|办理完成|处理完毕|已成功提交|提交成功|报名成功|注册成功|已成功注册",
            r"(?:has been|was) completed|completed successfully|successfully (?:submitted|registered|enrolled)|"
            r"submission (?:was )?successful|you(?:'re| are) all set|registration (?:is )?complete",
            r"erfolgreich (?:eingereicht|abgeschlossen|registriert|angemeldet|zurückgemeldet)|ist erledigt|abgeschlossen",
        ),
    ),
    (
        CompletionKind.APPROVED,
        _rx(r"已通过|已批准|审核通过|已获批", r"(?:has been|was|is) approved|application (?:was )?accepted", r"genehmigt|bewilligt|wurde angenommen"),
    ),
    (CompletionKind.CANCELLED, _rx(r"已取消", r"(?:has been|was) cancel+ed", r"storniert|abgesagt")),
    (
        CompletionKind.IN_REVIEW,
        _rx(r"正在处理|审核中|处理中|正在审核", r"(?:is|are) being processed|under review|in review", r"wird bearbeitet|in Bearbeitung|wird geprüft"),
    ),
]

APPOINTMENT_CUES = _rx(
    r"预约时间|面谈|会议|考试时间|面试|讲座|会面|报告会|预约于|您的预约",
    r"\bappointment\b|\bmeeting\b|\binterview\b|\bexam\b|\btakes place\b|\bscheduled for\b",
    r"\bTermin\b|Sprechstunde|Vorstellungsgespräch|Prüfung|Klausur|findet\s.{0,40}?statt|Besprechung",
)

# ---------------------------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------------------------

CATEGORY_KEYWORDS: dict[Category, re.Pattern[str]] = {
    Category.ACADEMIC: _rx(
        r"课程|学期|考试|作业|论文|选课|教务|学籍|在读证明|学生证明|成绩|讲座|导师|毕业|学分|大学|学院|教授",
        r"TUMonline|Moodle|\bsemester\b|\bcourse\b|\bexam\b|\blecture\b|\bthesis\b|enrol+ment|assignment|homework|"
        r"tutorial|seminar|\bmodule\b|transcript|universit|professor|faculty|student",
        r"Studium|Studien|Semester|Prüfung|Klausur|Vorlesung|Hausarbeit|Abschlussarbeit|Immatrikulation|"
        r"Rückmeldung|Lehrstuhl|Übung|Modul|Studierende|Hochschule|Universität|Fakultät|\bTUM\b|\bLMU\b",
    ),
    Category.ADMINISTRATIVE: _rx(
        r"签证|居留|外管局|市政厅|户籍|证件|护照|医保|保险|税号|住址登记|地址登记|政府|大使馆|领事馆",
        r"\bvisa\b|residence permit|registration office|passport|insurance|\btax\b|authorit|embassy|consulate|"
        r"city hall|government|immigration",
        r"Anmeldung|Ausländerbehörde|Kreisverwaltungsreferat|\bKVR\b|Bürgeramt|Aufenthaltstitel|Aufenthaltserlaubnis|"
        r"Visum|Rundfunkbeitrag|Krankenversicherung|Steuer|Finanzamt|Behörde|Antrag|Meldebescheinigung|Reisepass",
    ),
    Category.FINANCIAL: _rx(
        r"缴费|学费|学期费|付款|支付|账单|发票|银行|转账|汇款|费用|欧元|房租|押金|信用卡",
        r"\btuition\b|\bfee\b|\bfees\b|payment|invoice|\bbill\b|\bbank(?:ing)?\b|\btransfer\b|\bamount\b|balance|"
        r"credit card|\brent\b|deposit|€|\bEUR\b",
        r"Überweisung|Rechnung|Beitrag|Semesterbeitrag|Gebühr|Zahlung|Konto|IBAN|Betrag|Mahnung|Lastschrift|"
        r"Miete|Kaution",
    ),
    Category.TRAVEL: _rx(
        r"航班|火车|机票|酒店|行程|登机|值机|高铁|车票",
        r"\bflight\b|\btrain\b|boarding|check-in|\bhotel\b|itinerary|\bairline\b|\bticket\b",
        r"\bFlug\b|\bZug\b|\bBahn\b|Reise|Hotel|Buchung|Lufthansa|Fahrkarte",
    ),
    Category.PERSONAL: _rx(
        r"医生|牙医|体检|生日|家人|朋友|健身|理发|快递|取件|租房|房东|租约|公寓",
        r"\bdoctor\b|dentist|birthday|\bgym\b|haircut|pickup|package|parcel|pharmacy|rental|tenant|landlord|"
        r"apartment|\blease\b",
        r"\bArzt\b|Zahnarzt|Geburtstag|Praxis|Hausarzt|Friseur|Abholung|Paket|Apotheke|Mietvertrag|Vermieter|"
        r"Wohnung|Mieter",
    ),
}

# ---------------------------------------------------------------------------------------------
# Entities: canonical id -> (weight, pattern). Cross-language synonyms map to one id so that a
# Chinese notice and a German reminder about the same document can be matched.
# ---------------------------------------------------------------------------------------------

ENTITY_PATTERNS: dict[str, tuple[float, re.Pattern[str]]] = {
    "enrollment_certificate": (
        1.0,
        _rx(
            r"在读证明|学生证明|学籍证明|在学证明|注册证明",
            r"enrol+ment certificate|certificate of enrol+ment|student certificate|proof of enrol+ment",
            r"Immatrikulationsbescheinigung|Studienbescheinigung|Immatrikulationsnachweis",
        ),
    ),
    "tuition_fee": (
        1.0,
        _rx(
            r"学费|学期费|学期费用|注册费",
            r"semester (?:fee|contribution)|tuition(?: fee)?|student fee",
            r"Semesterbeitrag|Studiengebühr|Studienbeitrag|Semestergebühr",
        ),
    ),
    "residence_permit": (
        1.0,
        _rx(r"居留许可|居留卡|居留", r"residence (?:permit|title|card)", r"Aufenthaltstitel|Aufenthaltserlaubnis|\beAT\b|Niederlassungserlaubnis"),
    ),
    "visa": (0.9, _rx(r"签证", r"\bvisa\b", r"Visum")),
    "address_registration": (
        1.0,
        _rx(r"住址登记|地址登记|居住登记", r"address registration|registration certificate", r"Wohnsitzanmeldung|Meldebescheinigung|\bAnmeldung\b"),
    ),
    "health_insurance": (
        1.0,
        _rx(r"医保|医疗保险|健康保险", r"health insurance", r"Krankenversicherung|Versicherungsbescheinigung|Krankenkasse"),
    ),
    "exam_registration": (1.0, _rx(r"考试报名|考试注册", r"exam registration|register for (?:the )?exam", r"Prüfungsanmeldung|Klausuranmeldung")),
    "course_registration": (
        1.0,
        _rx(r"选课|课程注册|课程报名", r"course registration|module registration|register for (?:the )?course", r"Kursanmeldung|Modulanmeldung|Lehrveranstaltungsanmeldung"),
    ),
    "re_registration": (1.0, _rx(r"学期注册|续注册", r"re-?registration", r"Rückmeldung")),
    "passport": (0.7, _rx(r"护照", r"passport", r"Reisepass")),
    "rent": (0.9, _rx(r"房租|租金", r"\brent\b", r"\bMiete\b")),
    "broadcast_fee": (1.0, _rx(r"广播费", r"broadcast(?:ing)? fee|licen[cs]e fee", r"Rundfunkbeitrag|\bGEZ\b")),
    "thesis": (1.0, _rx(r"毕业论文|论文", r"\bthesis\b", r"Abschlussarbeit|Masterarbeit|Bachelorarbeit")),
    "homework": (0.9, _rx(r"作业", r"assignment|homework|exercise sheet", r"Hausaufgabe|Übungsblatt|Hausarbeit")),
    "transcript": (0.9, _rx(r"成绩单", r"transcript", r"Notenspiegel|Transcript of Records|Leistungsnachweis")),
    "photo": (0.6, _rx(r"照片", r"\bphoto\b", r"Lichtbild|Passfoto|Foto")),
    "bank_account": (0.7, _rx(r"银行账户|银行卡", r"bank account", r"Bankkonto|Girokonto")),
    "tax_id": (0.9, _rx(r"税号", r"tax id|tax identification", r"Steuer-?ID|Steueridentifikationsnummer")),
    "address_change": (0.9, _rx(r"新地址|地址变更|更新地址", r"address change|new address|update your address", r"Adressänderung|neue Adresse")),
    "semester_ticket": (0.9, _rx(r"学期票", r"semester ticket", r"Semesterticket|Deutschlandticket")),
    "application_form": (0.6, _rx(r"申请表|表格", r"application form|\bform\b", r"Antragsformular|Formular")),
    "library_books": (0.9, _rx(r"图书馆|借书|还书", r"library books?|return (?:the )?books", r"Bibliothek|Bücher zurückgeben|Leihfrist")),
    "rsvp": (0.6, _rx(r"是否参加|出席情况", r"\bRSVP\b|whether you (?:will )?attend", r"Teilnahme bestätigen|ob Sie teilnehmen")),
    "documents": (0.3, _rx(r"材料|文件|资料", r"\bdocuments?\b|paperwork", r"Unterlagen|Dokumente|Nachweise")),
    "appointment": (0.3, _rx(r"预约", r"appointment", r"\bTermin\b")),
    "payment": (0.2, _rx(r"款项", r"\bpayment\b", r"\bZahlung\b")),
}


def detect_entities(text: str) -> list[str]:
    found = [name for name, (_, pattern) in ENTITY_PATTERNS.items() if pattern.search(text)]
    # 'tuition_fee' and 'payment' overlap; prefer the specific one.
    if "tuition_fee" in found and "payment" in found:
        found.remove("payment")
    return found


def entity_weight(name: str) -> float:
    return ENTITY_PATTERNS.get(name, (0.5, None))[0]  # type: ignore[return-value]


GENERIC_ACTIONS = {ActionType.PREPARE, ActionType.OTHER}


def detect_action(text: str, start: int = 0) -> tuple[ActionType, re.Match[str]] | None:
    """Return the leftmost action verb at or after ``start``; a generic verb ("完成", "complete")
    yields to a specific one that follows closely ("完成选课" -> register)."""
    found: list[tuple[ActionType, re.Match[str]]] = []
    for action, pattern in ACTION_PATTERNS:
        m = pattern.search(text, start)
        if m:
            found.append((action, m))
    if not found:
        return None
    found.sort(key=lambda item: item[1].start())
    first = found[0]
    if first[0] in GENERIC_ACTIONS:
        for action, m in found[1:]:
            if action not in GENERIC_ACTIONS and m.start() - first[1].end() <= 12:
                return action, m
    return first


def detect_instructed_action(text: str) -> tuple[ActionType, re.Match[str]] | None:
    """Prefer the action that follows an obligation cue ("请…上传", "please submit", "Bitte reichen …")
    over verbs in a preceding purpose clause ("为完成学籍注册，请于…上传…")."""
    cue = OBLIGATION_CUES.search(text)
    if cue is not None:
        found = detect_action(text, cue.start())
        if found is not None:
            return found
    return detect_action(text)


def detect_category(text: str, action: ActionType | None = None) -> Category:
    scores: dict[Category, float] = {}
    for category, pattern in CATEGORY_KEYWORDS.items():
        hits = len(pattern.findall(text))
        if hits:
            scores[category] = float(hits)
    if action == ActionType.PAY:
        scores[Category.FINANCIAL] = scores.get(Category.FINANCIAL, 0) + 2.5
    if not scores:
        return Category.OTHER
    return max(scores.items(), key=lambda kv: kv[1])[0]


ACTION_LABELS: dict[str, dict[ActionType, str]] = {
    "zh": {
        ActionType.SUBMIT: "提交", ActionType.PAY: "缴纳", ActionType.REGISTER: "注册", ActionType.REPLY: "回复",
        ActionType.CONFIRM: "确认", ActionType.ATTEND: "参加", ActionType.BOOK: "预约", ActionType.UPLOAD: "上传",
        ActionType.SIGN: "签署", ActionType.RENEW: "续签", ActionType.APPLY: "申请", ActionType.BRING: "携带",
        ActionType.PREPARE: "完成", ActionType.CANCEL: "取消", ActionType.OTHER: "处理",
    },
    "en": {
        ActionType.SUBMIT: "Submit", ActionType.PAY: "Pay", ActionType.REGISTER: "Register", ActionType.REPLY: "Reply",
        ActionType.CONFIRM: "Confirm", ActionType.ATTEND: "Attend", ActionType.BOOK: "Book", ActionType.UPLOAD: "Upload",
        ActionType.SIGN: "Sign", ActionType.RENEW: "Renew", ActionType.APPLY: "Apply for", ActionType.BRING: "Bring",
        ActionType.PREPARE: "Complete", ActionType.CANCEL: "Cancel", ActionType.OTHER: "Handle",
    },
    "de": {
        ActionType.SUBMIT: "einreichen", ActionType.PAY: "bezahlen", ActionType.REGISTER: "anmelden",
        ActionType.REPLY: "beantworten", ActionType.CONFIRM: "bestätigen", ActionType.ATTEND: "teilnehmen",
        ActionType.BOOK: "buchen", ActionType.UPLOAD: "hochladen", ActionType.SIGN: "unterschreiben",
        ActionType.RENEW: "verlängern", ActionType.APPLY: "beantragen", ActionType.BRING: "mitbringen",
        ActionType.PREPARE: "erledigen", ActionType.CANCEL: "stornieren", ActionType.OTHER: "erledigen",
    },
}

ENTITY_LABELS: dict[str, dict[str, str]] = {
    "enrollment_certificate": {"zh": "在读证明", "en": "enrollment certificate", "de": "Immatrikulationsbescheinigung"},
    "tuition_fee": {"zh": "学期费", "en": "semester fee", "de": "Semesterbeitrag"},
    "residence_permit": {"zh": "居留许可材料", "en": "residence permit documents", "de": "Unterlagen für den Aufenthaltstitel"},
    "visa": {"zh": "签证", "en": "visa", "de": "Visum"},
    "address_registration": {"zh": "住址登记", "en": "address registration", "de": "Wohnsitzanmeldung"},
    "health_insurance": {"zh": "医保证明", "en": "health insurance certificate", "de": "Versicherungsbescheinigung"},
    "exam_registration": {"zh": "考试报名", "en": "exam registration", "de": "Prüfungsanmeldung"},
    "course_registration": {"zh": "选课", "en": "course registration", "de": "Kursanmeldung"},
    "re_registration": {"zh": "学期注册", "en": "semester re-registration", "de": "Rückmeldung"},
    "thesis": {"zh": "论文", "en": "thesis", "de": "Abschlussarbeit"},
}
