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
            r"bezahlen|zahlen|überweisen|begleichen|entrichten|zahlbar|(?:überwiesen|bezahlt|beglichen)\s+(?:werden|sein)\b",
        ),
    ),
    (
        ActionType.REGISTER,
        _rx(
            r"报名|注册|登记|选课|申报|报到",
            r"(?<![\w-])register\w*|\b(?:re|pre)-?register\w*|\benrol+\w*|\bsign up\b",
            r"anmelden|anzumelden|melden\s+Sie\s+sich\b.{0,200}?\ban\b|registrieren|einschreiben|zurückmelden|"
            r"zurückzumelden|immatrikulieren",
        ),
    ),
    (
        ActionType.SUBMIT,
        _rx(
            r"提交|递交|呈交|上交|交回|寄送|寄回|补交|补充提交|提供|发给|发送给|寄给|交给",
            r"\bsubmit\w*|\bbe received\b|\bhand in\b|\bturn in\b|\bsend (?:us|me|in|back)\b|\bprovide\b|\breturn (?:the|your|them|it)\b",
            r"(?:eingereicht|vorgelegt|abgegeben|eingegangen|zugegangen)\s+(?:werden|sein)\b|einreichen|einzureichen|reichen\s+Sie\b.{0,200}?\bein\b|abgeben|abzugeben|geben\s+Sie\b.{0,200}?\bab\b|"
            r"vorlegen|vorzulegen|legen\s+Sie\b.{0,200}?\bvor\b|nachreichen|nachzureichen|zusenden|zuzusenden|"
            r"zukommen (?:zu )?lassen|übermitteln|einsenden|einzusenden|senden\s+Sie|schicken\s+Sie|"
            r"zurückschicken|zurückzuschicken|zurücksenden|zurückzusenden|zuschicken|zuzuschicken|"
            r"zurückgeben|zurückzugeben|geben\s+Sie\b.{0,200}?\bzurück\b",
        ),
    ),
    (
        ActionType.REPLY,
        _rx(
            r"回复|答复|回信|反馈",
            r"\breply\b|\brespond\b|\bget back to\b|\blet us know\b|\banswer\b|\bRSVP\b",
            r"antworten|beantworten|rückmelden|melden\s+Sie\s+sich|Rückantwort|teilen\s+Sie\s+uns\b.{0,40}?\bmit\b",
        ),
    ),
    (ActionType.CONFIRM, _rx(r"确认", r"\bconfirm\w*|\bverify\b|\backnowledge\b", r"bestätigen")),
    (ActionType.SIGN, _rx(r"签署|签字|签名|签订", r"\bsign\b|\bcountersign\b", r"unterschreiben|unterzeichnen")),
    (ActionType.RENEW, _rx(r"续签|续期|延长签证", r"\brenew\w*|\bextend your\b", r"verlängern|erneuern")),
    (ActionType.APPLY, _rx(r"申请|办理", r"\bapply\b|\bapply for\b", r"beantragen|bewerben\s+Sie|Antrag stellen")),
    (
        ActionType.BOOK,
        _rx(r"预约|预订", r"\bbook\b|\bschedule\b|\breserve\b|make an appointment", r"buchen|vereinbaren|reservieren"),
    ),
    (
        ActionType.ATTEND,
        _rx(
            r"参加|出席|到场",
            r"\battend\b|\bjoin\b|\bparticipate\b|\bbe present\b",
            r"teilnehmen|erscheinen\s+Sie|besuchen\s+Sie",
        ),
    ),
    (
        ActionType.BRING,
        _rx(r"携带|带上|带好", r"\bbring\b|\bcarry\b", r"mitbringen|mitzubringen|bringen\s+Sie\b.{0,200}?\bmit\b"),
    ),
    (
        ActionType.PREPARE,
        _rx(
            r"填写|填报|完成|准备|更新",
            r"\bcomplete\b|\bbe completed\b|\bfill (?:in|out)\b|\bprepare\b|\bupdate\b",
            r"ausfüllen|auszufüllen|füllen\s+Sie\b.{0,200}?\baus\b|erledigen|zu erledigen|vorbereiten|aktualisieren",
        ),
    ),
    # "If you do not take action before 3 November, ..." - something has to be done; the mail says what.
    (ActionType.OTHER, _rx(r"采取行动|采取措施", r"\btake action\b", r"tätig werden|aktiv werden")),
]


def _tolerate_wraps(pattern: re.Pattern[str]) -> re.Pattern[str]:
    """Let Chinese words match across a soft line wrap ("采取行 动", left by hard-wrapped HTML mails)."""
    out: list[str] = []
    in_class = escaped = prev_cjk = False
    for ch in pattern.pattern:
        cjk = not escaped and not in_class and "一" <= ch <= "鿿"
        if cjk and prev_cjk:
            out.append(" ?")
        out.append(ch)
        if escaped:
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == "[":
            in_class = True
        elif ch == "]":
            in_class = False
        prev_cjk = cjk
    return re.compile("".join(out), pattern.flags)


ACTION_PATTERNS = [(action, _tolerate_wraps(pattern)) for action, pattern in ACTION_PATTERNS]


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
        _rx(
            r"已通过|已批准|审核通过|已获批",
            r"(?:has been|was|is) approved|application (?:was )?accepted",
            r"genehmigt|bewilligt|wurde angenommen",
        ),
    ),
    (CompletionKind.CANCELLED, _rx(r"已取消", r"(?:has been|was) cancel+ed", r"storniert|abgesagt")),
    (
        CompletionKind.IN_REVIEW,
        _rx(
            r"正在处理|审核中|处理中|正在审核",
            r"(?:is|are) being processed|under review|in review",
            r"wird bearbeitet|in Bearbeitung|wird geprüft",
        ),
    ),
]

APPOINTMENT_CUES = _rx(
    r"预约时间|面谈|会议|考试时间|面试|讲座|会面|报告会|预约于|您的预约|安排在|定于|举行",
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

GENERIC_ACTIONS = {ActionType.PREPARE, ActionType.OTHER}


# A Chinese verb followed by 的 describes a noun ("您上传的文件", "发送给您的邮件"); it is not an instruction.
_ATTRIBUTIVE = re.compile(r"(?:您|你|我们|他们|过|了)?的")


def _search_action(pattern: re.Pattern[str], text: str, start: int) -> re.Match[str] | None:
    m = pattern.search(text, start)
    while m is not None and _CJK_VERB.match(m.group(0)) and _ATTRIBUTIVE.match(text, m.end()):
        m = pattern.search(text, m.end())
    return m


_CJK_VERB = re.compile(r"[\u4e00-\u9fff]")


def detect_action(text: str, start: int = 0) -> tuple[ActionType, re.Match[str]] | None:
    """Return the leftmost action verb at or after ``start``; a generic verb ("完成", "complete")
    yields to a specific one that follows closely ("完成选课" -> register)."""
    found: list[tuple[ActionType, re.Match[str]]] = []
    for action, pattern in ACTION_PATTERNS:
        m = _search_action(pattern, text, start)
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
        ActionType.SUBMIT: "提交",
        ActionType.PAY: "缴纳",
        ActionType.REGISTER: "注册",
        ActionType.REPLY: "回复",
        ActionType.CONFIRM: "确认",
        ActionType.ATTEND: "参加",
        ActionType.BOOK: "预约",
        ActionType.UPLOAD: "上传",
        ActionType.SIGN: "签署",
        ActionType.RENEW: "续签",
        ActionType.APPLY: "申请",
        ActionType.BRING: "携带",
        ActionType.PREPARE: "完成",
        ActionType.CANCEL: "取消",
        ActionType.OTHER: "处理",
    },
    "en": {
        ActionType.SUBMIT: "Submit",
        ActionType.PAY: "Pay",
        ActionType.REGISTER: "Register",
        ActionType.REPLY: "Reply",
        ActionType.CONFIRM: "Confirm",
        ActionType.ATTEND: "Attend",
        ActionType.BOOK: "Book",
        ActionType.UPLOAD: "Upload",
        ActionType.SIGN: "Sign",
        ActionType.RENEW: "Renew",
        ActionType.APPLY: "Apply for",
        ActionType.BRING: "Bring",
        ActionType.PREPARE: "Complete",
        ActionType.CANCEL: "Cancel",
        ActionType.OTHER: "Handle",
    },
    "de": {
        ActionType.SUBMIT: "einreichen",
        ActionType.PAY: "bezahlen",
        ActionType.REGISTER: "anmelden",
        ActionType.REPLY: "beantworten",
        ActionType.CONFIRM: "bestätigen",
        ActionType.ATTEND: "teilnehmen",
        ActionType.BOOK: "buchen",
        ActionType.UPLOAD: "hochladen",
        ActionType.SIGN: "unterschreiben",
        ActionType.RENEW: "verlängern",
        ActionType.APPLY: "beantragen",
        ActionType.BRING: "mitbringen",
        ActionType.PREPARE: "erledigen",
        ActionType.CANCEL: "stornieren",
        ActionType.OTHER: "erledigen",
    },
}

ENTITY_LABELS: dict[str, dict[str, str]] = {
    "enrollment_certificate": {"zh": "在读证明", "en": "enrollment certificate", "de": "Immatrikulationsbescheinigung"},
    "tuition_fee": {"zh": "学期费", "en": "semester fee", "de": "Semesterbeitrag"},
    "residence_permit": {
        "zh": "居留许可材料",
        "en": "residence permit documents",
        "de": "Unterlagen für den Aufenthaltstitel",
    },
    "visa": {"zh": "签证", "en": "visa", "de": "Visum"},
    "address_registration": {"zh": "住址登记", "en": "address registration", "de": "Wohnsitzanmeldung"},
    "health_insurance": {"zh": "医保证明", "en": "health insurance certificate", "de": "Versicherungsbescheinigung"},
    "exam_registration": {"zh": "考试报名", "en": "exam registration", "de": "Prüfungsanmeldung"},
    "course_registration": {"zh": "选课", "en": "course registration", "de": "Kursanmeldung"},
    "re_registration": {"zh": "学期注册", "en": "semester re-registration", "de": "Rückmeldung"},
    "thesis": {"zh": "论文", "en": "thesis", "de": "Abschlussarbeit"},
}
