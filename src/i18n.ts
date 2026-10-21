import { invoke } from "./ipc.js";

type Dict = Record<string, string>;

const en: Dict = {
  "file.save": "Save", "file.saveAs": "Save As…", "file.saveAll": "Save All",
  "file.recent": "Recent", "file.open": "Open…", "file.print": "Print",
  "file.allNotes": "All notes", "file.browse": "Browse with locations…",
  "rail.agent": "Agent", "rail.schedule": "Schedule", "rail.skills": "Skills",
  "rail.credits": "Credits", "rail.activity": "Activity", "rail.files": "Files",
  "ed.saved": "saved", "ed.saving": "saving…", "ed.failed": "save failed",
  "cal.today": "Today", "cal.newSchedule": "New schedule", "cal.repeats": "Repeats",
  "cal.time": "Time", "cal.action": "Action", "cal.text": "Text",
  "cal.intoNote": "Into note", "cal.create": "Create schedule",
  "cal.runNow": "Run now", "cal.pause": "Pause", "cal.delete": "Delete",
  "cal.note": "Note", "cal.nothing": "nothing scheduled",
  "notice.reminder": "Reminder", "notice.brief": "Brief", "notice.review": "Review",
  "notice.research": "Research", "notice.view": "click to view", "notice.dismiss": "Dismiss",
  "reader.saveAs": "Save as note", "reader.openNote": "Open note", "reader.close": "Close",
  "set.language": "Language", "set.save": "Save & test", "set.test": "Test", "set.close": "Close",
  "skills.history": "History", "skills.newSticky": "New sticky note",
};

const es: Dict = {
  "file.save": "Guardar", "file.saveAs": "Guardar como…", "file.saveAll": "Guardar todo",
  "file.recent": "Recientes", "file.open": "Abrir…", "file.print": "Imprimir",
  "file.allNotes": "Todas las notas", "file.browse": "Explorar con ubicaciones…",
  "rail.agent": "Agente", "rail.schedule": "Agenda", "rail.skills": "Habilidades",
  "rail.credits": "Créditos", "rail.activity": "Actividad", "rail.files": "Archivos",
  "ed.saved": "guardado", "ed.saving": "guardando…", "ed.failed": "error al guardar",
  "cal.today": "Hoy", "cal.newSchedule": "Nueva tarea", "cal.repeats": "Repite",
  "cal.time": "Hora", "cal.action": "Acción", "cal.text": "Texto",
  "cal.intoNote": "En la nota", "cal.create": "Crear tarea",
  "cal.runNow": "Ejecutar", "cal.pause": "Pausar", "cal.delete": "Eliminar",
  "cal.note": "Nota", "cal.nothing": "nada programado",
  "notice.reminder": "Recordatorio", "notice.brief": "Resumen", "notice.review": "Revisión",
  "notice.research": "Investigación", "notice.view": "clic para ver", "notice.dismiss": "Descartar",
  "reader.saveAs": "Guardar como nota", "reader.openNote": "Abrir nota", "reader.close": "Cerrar",
  "set.language": "Idioma", "set.save": "Guardar y probar", "set.test": "Probar", "set.close": "Cerrar",
  "skills.history": "Historial", "skills.newSticky": "Nueva nota adhesiva",
};

const fr: Dict = {
  "file.save": "Enregistrer", "file.saveAs": "Enregistrer sous…", "file.saveAll": "Tout enregistrer",
  "file.recent": "Récents", "file.open": "Ouvrir…", "file.print": "Imprimer",
  "file.allNotes": "Toutes les notes", "file.browse": "Parcourir avec emplacements…",
  "rail.agent": "Agent", "rail.schedule": "Agenda", "rail.skills": "Compétences",
  "rail.credits": "Crédits", "rail.activity": "Activité", "rail.files": "Fichiers",
  "ed.saved": "enregistré", "ed.saving": "enregistrement…", "ed.failed": "échec de l'enregistrement",
  "cal.today": "Aujourd'hui", "cal.newSchedule": "Nouvelle tâche", "cal.repeats": "Répétition",
  "cal.time": "Heure", "cal.action": "Action", "cal.text": "Texte",
  "cal.intoNote": "Dans la note", "cal.create": "Créer la tâche",
  "cal.runNow": "Exécuter", "cal.pause": "Pause", "cal.delete": "Supprimer",
  "cal.note": "Note", "cal.nothing": "rien de planifié",
  "notice.reminder": "Rappel", "notice.brief": "Résumé", "notice.review": "Bilan",
  "notice.research": "Recherche", "notice.view": "cliquer pour voir", "notice.dismiss": "Ignorer",
  "reader.saveAs": "Enregistrer comme note", "reader.openNote": "Ouvrir la note", "reader.close": "Fermer",
  "set.language": "Langue", "set.save": "Enregistrer et tester", "set.test": "Tester", "set.close": "Fermer",
  "skills.history": "Historique", "skills.newSticky": "Nouvelle note adhésive",
};

const de: Dict = {
  "file.save": "Speichern", "file.saveAs": "Speichern unter…", "file.saveAll": "Alle speichern",
  "file.recent": "Zuletzt", "file.open": "Öffnen…", "file.print": "Drucken",
  "file.allNotes": "Alle Notizen", "file.browse": "Mit Speicherorten durchsuchen…",
  "rail.agent": "Agent", "rail.schedule": "Zeitplan", "rail.skills": "Fähigkeiten",
  "rail.credits": "Guthaben", "rail.activity": "Aktivität", "rail.files": "Dateien",
  "ed.saved": "gespeichert", "ed.saving": "speichern…", "ed.failed": "Speichern fehlgeschlagen",
  "cal.today": "Heute", "cal.newSchedule": "Neuer Termin", "cal.repeats": "Wiederholung",
  "cal.time": "Zeit", "cal.action": "Aktion", "cal.text": "Text",
  "cal.intoNote": "In Notiz", "cal.create": "Termin erstellen",
  "cal.runNow": "Jetzt ausführen", "cal.pause": "Pausieren", "cal.delete": "Löschen",
  "cal.note": "Notiz", "cal.nothing": "nichts geplant",
  "notice.reminder": "Erinnerung", "notice.brief": "Bericht", "notice.review": "Rückblick",
  "notice.research": "Recherche", "notice.view": "zum Ansehen klicken", "notice.dismiss": "Verwerfen",
  "reader.saveAs": "Als Notiz speichern", "reader.openNote": "Notiz öffnen", "reader.close": "Schließen",
  "set.language": "Sprache", "set.save": "Speichern & testen", "set.test": "Testen", "set.close": "Schließen",
  "skills.history": "Verlauf", "skills.newSticky": "Neue Haftnotiz",
};

const pt: Dict = {
  "file.save": "Salvar", "file.saveAs": "Salvar como…", "file.saveAll": "Salvar tudo",
  "file.recent": "Recentes", "file.open": "Abrir…", "file.print": "Imprimir",
  "file.allNotes": "Todas as notas", "file.browse": "Explorar com localizações…",
  "rail.agent": "Agente", "rail.schedule": "Agenda", "rail.skills": "Habilidades",
  "rail.credits": "Créditos", "rail.activity": "Atividade", "rail.files": "Arquivos",
  "ed.saved": "salvo", "ed.saving": "salvando…", "ed.failed": "falha ao salvar",
  "cal.today": "Hoje", "cal.newSchedule": "Nova tarefa", "cal.repeats": "Repete",
  "cal.time": "Hora", "cal.action": "Ação", "cal.text": "Texto",
  "cal.intoNote": "Na nota", "cal.create": "Criar tarefa",
  "cal.runNow": "Executar", "cal.pause": "Pausar", "cal.delete": "Excluir",
  "cal.note": "Nota", "cal.nothing": "nada agendado",
  "notice.reminder": "Lembrete", "notice.brief": "Resumo", "notice.review": "Revisão",
  "notice.research": "Pesquisa", "notice.view": "clique para ver", "notice.dismiss": "Dispensar",
  "reader.saveAs": "Salvar como nota", "reader.openNote": "Abrir nota", "reader.close": "Fechar",
  "set.language": "Idioma", "set.save": "Salvar e testar", "set.test": "Testar", "set.close": "Fechar",
  "skills.history": "Histórico", "skills.newSticky": "Nova nota adesiva",
};

const it: Dict = {
  "file.save": "Salva", "file.saveAs": "Salva come…", "file.saveAll": "Salva tutto",
  "file.recent": "Recenti", "file.open": "Apri…", "file.print": "Stampa",
  "file.allNotes": "Tutte le note", "file.browse": "Sfoglia con percorsi…",
  "rail.agent": "Agente", "rail.schedule": "Agenda", "rail.skills": "Competenze",
  "rail.credits": "Crediti", "rail.activity": "Attività",
  "ed.saved": "salvato", "ed.saving": "salvataggio…", "ed.failed": "salvataggio non riuscito",
  "cal.today": "Oggi", "cal.newSchedule": "Nuovo impegno", "cal.repeats": "Ripetizione",
  "cal.time": "Ora", "cal.action": "Azione", "cal.text": "Testo",
  "cal.intoNote": "Nella nota", "cal.create": "Crea impegno",
  "cal.runNow": "Esegui ora", "cal.pause": "Pausa", "cal.delete": "Elimina",
  "cal.note": "Nota", "cal.nothing": "niente in programma",
  "notice.reminder": "Promemoria", "notice.brief": "Riepilogo", "notice.review": "Revisione",
  "notice.research": "Ricerca", "notice.view": "clicca per vedere", "notice.dismiss": "Ignora",
  "reader.saveAs": "Salva come nota", "reader.openNote": "Apri nota", "reader.close": "Chiudi",
  "set.language": "Lingua", "set.save": "Salva e prova", "set.test": "Prova", "set.close": "Chiudi",
  "skills.history": "Cronologia", "skills.newSticky": "Nuova nota adesiva",
};

const nl: Dict = {
  "file.save": "Opslaan", "file.saveAs": "Opslaan als…", "file.saveAll": "Alles opslaan",
  "file.recent": "Recent", "file.open": "Openen…", "file.print": "Afdrukken",
  "file.allNotes": "Alle notities", "file.browse": "Bladeren met locaties…",
  "rail.agent": "Agent", "rail.schedule": "Planning", "rail.skills": "Vaardigheden",
  "rail.credits": "Credits", "rail.activity": "Activiteit",
  "ed.saved": "opgeslagen", "ed.saving": "opslaan…", "ed.failed": "opslaan mislukt",
  "cal.today": "Vandaag", "cal.newSchedule": "Nieuwe taak", "cal.repeats": "Herhaalt",
  "cal.time": "Tijd", "cal.action": "Actie", "cal.text": "Tekst",
  "cal.intoNote": "In notitie", "cal.create": "Taak aanmaken",
  "cal.runNow": "Nu uitvoeren", "cal.pause": "Pauzeren", "cal.delete": "Verwijderen",
  "cal.note": "Notitie", "cal.nothing": "niets gepland",
  "notice.reminder": "Herinnering", "notice.brief": "Overzicht", "notice.review": "Terugblik",
  "notice.research": "Onderzoek", "notice.view": "klik om te bekijken", "notice.dismiss": "Sluiten",
  "reader.saveAs": "Opslaan als notitie", "reader.openNote": "Notitie openen", "reader.close": "Sluiten",
  "set.language": "Taal", "set.save": "Opslaan en testen", "set.test": "Testen", "set.close": "Sluiten",
  "skills.history": "Geschiedenis", "skills.newSticky": "Nieuwe plaknotitie",
};

const ru: Dict = {
  "file.save": "Сохранить", "file.saveAs": "Сохранить как…", "file.saveAll": "Сохранить всё",
  "file.recent": "Недавние", "file.open": "Открыть…", "file.print": "Печать",
  "file.allNotes": "Все заметки", "file.browse": "Обзор с расположением…",
  "rail.agent": "Агент", "rail.schedule": "Расписание", "rail.skills": "Навыки",
  "rail.credits": "Кредиты", "rail.activity": "Активность",
  "ed.saved": "сохранено", "ed.saving": "сохранение…", "ed.failed": "ошибка сохранения",
  "cal.today": "Сегодня", "cal.newSchedule": "Новая задача", "cal.repeats": "Повтор",
  "cal.time": "Время", "cal.action": "Действие", "cal.text": "Текст",
  "cal.intoNote": "В заметку", "cal.create": "Создать задачу",
  "cal.runNow": "Запустить", "cal.pause": "Пауза", "cal.delete": "Удалить",
  "cal.note": "Заметка", "cal.nothing": "ничего не запланировано",
  "notice.reminder": "Напоминание", "notice.brief": "Сводка", "notice.review": "Обзор",
  "notice.research": "Исследование", "notice.view": "нажмите, чтобы посмотреть", "notice.dismiss": "Закрыть",
  "reader.saveAs": "Сохранить как заметку", "reader.openNote": "Открыть заметку", "reader.close": "Закрыть",
  "set.language": "Язык", "set.save": "Сохранить и проверить", "set.test": "Проверить", "set.close": "Закрыть",
  "skills.history": "История", "skills.newSticky": "Новая стикер-заметка",
};

const tr: Dict = {
  "file.save": "Kaydet", "file.saveAs": "Farklı kaydet…", "file.saveAll": "Tümünü kaydet",
  "file.recent": "Son kullanılanlar", "file.open": "Aç…", "file.print": "Yazdır",
  "file.allNotes": "Tüm notlar", "file.browse": "Konumlarla gözat…",
  "rail.agent": "Ajan", "rail.schedule": "Program", "rail.skills": "Yetenekler",
  "rail.credits": "Krediler", "rail.activity": "Etkinlik",
  "ed.saved": "kaydedildi", "ed.saving": "kaydediliyor…", "ed.failed": "kaydetme başarısız",
  "cal.today": "Bugün", "cal.newSchedule": "Yeni görev", "cal.repeats": "Tekrar",
  "cal.time": "Saat", "cal.action": "Eylem", "cal.text": "Metin",
  "cal.intoNote": "Nota", "cal.create": "Görev oluştur",
  "cal.runNow": "Şimdi çalıştır", "cal.pause": "Duraklat", "cal.delete": "Sil",
  "cal.note": "Not", "cal.nothing": "planlanmış bir şey yok",
  "notice.reminder": "Hatırlatma", "notice.brief": "Özet", "notice.review": "Değerlendirme",
  "notice.research": "Araştırma", "notice.view": "görüntülemek için tıklayın", "notice.dismiss": "Kapat",
  "reader.saveAs": "Not olarak kaydet", "reader.openNote": "Notu aç", "reader.close": "Kapat",
  "set.language": "Dil", "set.save": "Kaydet ve test et", "set.test": "Test et", "set.close": "Kapat",
  "skills.history": "Geçmiş", "skills.newSticky": "Yeni yapışkan not",
};

const ar: Dict = {
  "file.save": "حفظ", "file.saveAs": "حفظ باسم…", "file.saveAll": "حفظ الكل",
  "file.recent": "الأحدث", "file.open": "فتح…", "file.print": "طباعة",
  "file.allNotes": "كل الملاحظات", "file.browse": "تصفح مع المواقع…",
  "rail.agent": "الوكيل", "rail.schedule": "الجدول", "rail.skills": "المهارات",
  "rail.credits": "الرصيد", "rail.activity": "النشاط",
  "ed.saved": "تم الحفظ", "ed.saving": "جارٍ الحفظ…", "ed.failed": "فشل الحفظ",
  "cal.today": "اليوم", "cal.newSchedule": "مهمة جديدة", "cal.repeats": "التكرار",
  "cal.time": "الوقت", "cal.action": "الإجراء", "cal.text": "النص",
  "cal.intoNote": "إلى الملاحظة", "cal.create": "إنشاء مهمة",
  "cal.runNow": "تشغيل الآن", "cal.pause": "إيقاف مؤقت", "cal.delete": "حذف",
  "cal.note": "ملاحظة", "cal.nothing": "لا شيء مجدول",
  "notice.reminder": "تذكير", "notice.brief": "موجز", "notice.review": "مراجعة",
  "notice.research": "بحث", "notice.view": "انقر للعرض", "notice.dismiss": "إغلاق",
  "reader.saveAs": "حفظ كملاحظة", "reader.openNote": "فتح الملاحظة", "reader.close": "إغلاق",
  "set.language": "اللغة", "set.save": "حفظ واختبار", "set.test": "اختبار", "set.close": "إغلاق",
  "skills.history": "السجل", "skills.newSticky": "ملاحظة لاصقة جديدة",
};

const zh: Dict = {
  "file.save": "保存", "file.saveAs": "另存为…", "file.saveAll": "全部保存",
  "file.recent": "最近", "file.open": "打开…", "file.print": "打印",
  "file.allNotes": "所有笔记", "file.browse": "按位置浏览…",
  "rail.agent": "助手", "rail.schedule": "日程", "rail.skills": "技能",
  "rail.credits": "额度", "rail.activity": "动态",
  "ed.saved": "已保存", "ed.saving": "保存中…", "ed.failed": "保存失败",
  "cal.today": "今天", "cal.newSchedule": "新日程", "cal.repeats": "重复",
  "cal.time": "时间", "cal.action": "动作", "cal.text": "内容",
  "cal.intoNote": "写入笔记", "cal.create": "创建日程",
  "cal.runNow": "立即运行", "cal.pause": "暂停", "cal.delete": "删除",
  "cal.note": "笔记", "cal.nothing": "没有安排",
  "notice.reminder": "提醒", "notice.brief": "简报", "notice.review": "回顾",
  "notice.research": "研究", "notice.view": "点击查看", "notice.dismiss": "关闭",
  "reader.saveAs": "存为笔记", "reader.openNote": "打开笔记", "reader.close": "关闭",
  "set.language": "语言", "set.save": "保存并测试", "set.test": "测试", "set.close": "关闭",
  "skills.history": "历史", "skills.newSticky": "新建便签",
};

const ja: Dict = {
  "file.save": "保存", "file.saveAs": "名前を付けて保存…", "file.saveAll": "すべて保存",
  "file.recent": "最近", "file.open": "開く…", "file.print": "印刷",
  "file.allNotes": "すべてのノート", "file.browse": "場所を指定して開く…",
  "rail.agent": "エージェント", "rail.schedule": "スケジュール", "rail.skills": "スキル",
  "rail.credits": "クレジット", "rail.activity": "アクティビティ",
  "ed.saved": "保存済み", "ed.saving": "保存中…", "ed.failed": "保存に失敗",
  "cal.today": "今日", "cal.newSchedule": "新しい予定", "cal.repeats": "繰り返し",
  "cal.time": "時刻", "cal.action": "アクション", "cal.text": "テキスト",
  "cal.intoNote": "ノートへ", "cal.create": "予定を作成",
  "cal.runNow": "今すぐ実行", "cal.pause": "一時停止", "cal.delete": "削除",
  "cal.note": "ノート", "cal.nothing": "予定はありません",
  "notice.reminder": "リマインダー", "notice.brief": "ブリーフ", "notice.review": "レビュー",
  "notice.research": "リサーチ", "notice.view": "クリックして表示", "notice.dismiss": "閉じる",
  "reader.saveAs": "ノートとして保存", "reader.openNote": "ノートを開く", "reader.close": "閉じる",
  "set.language": "言語", "set.save": "保存してテスト", "set.test": "テスト", "set.close": "閉じる",
  "skills.history": "履歴", "skills.newSticky": "新しい付箋",
};

const ko: Dict = {
  "file.save": "저장", "file.saveAs": "다른 이름으로 저장…", "file.saveAll": "모두 저장",
  "file.recent": "최근", "file.open": "열기…", "file.print": "인쇄",
  "file.allNotes": "모든 노트", "file.browse": "위치와 함께 찾아보기…",
  "rail.agent": "에이전트", "rail.schedule": "일정", "rail.skills": "스킬",
  "rail.credits": "크레딧", "rail.activity": "활동",
  "ed.saved": "저장됨", "ed.saving": "저장 중…", "ed.failed": "저장 실패",
  "cal.today": "오늘", "cal.newSchedule": "새 일정", "cal.repeats": "반복",
  "cal.time": "시간", "cal.action": "동작", "cal.text": "내용",
  "cal.intoNote": "노트에 저장", "cal.create": "일정 만들기",
  "cal.runNow": "지금 실행", "cal.pause": "일시중지", "cal.delete": "삭제",
  "cal.note": "노트", "cal.nothing": "예정 없음",
  "notice.reminder": "알림", "notice.brief": "브리핑", "notice.review": "리뷰",
  "notice.research": "리서치", "notice.view": "클릭하여 보기", "notice.dismiss": "닫기",
  "reader.saveAs": "노트로 저장", "reader.openNote": "노트 열기", "reader.close": "닫기",
  "set.language": "언어", "set.save": "저장 및 테스트", "set.test": "테스트", "set.close": "닫기",
  "skills.history": "기록", "skills.newSticky": "새 스티커 노트",
};

const fil: Dict = {
  "file.save": "I-save", "file.saveAs": "I-save bilang…", "file.saveAll": "I-save lahat",
  "file.recent": "Kamakailan", "file.open": "Buksan…", "file.print": "I-print",
  "file.allNotes": "Lahat ng nota", "file.browse": "Mag-browse na may lokasyon…",
  "rail.agent": "Ahente", "rail.schedule": "Iskedyul", "rail.skills": "Mga kasanayan",
  "rail.credits": "Kredito", "rail.activity": "Aktibidad",
  "ed.saved": "naka-save", "ed.saving": "nagse-save…", "ed.failed": "bigong mag-save",
  "cal.today": "Ngayon", "cal.newSchedule": "Bagong iskedyul", "cal.repeats": "Uulitin",
  "cal.time": "Oras", "cal.action": "Aksyon", "cal.text": "Teksto",
  "cal.intoNote": "Sa nota", "cal.create": "Gumawa ng iskedyul",
  "cal.runNow": "Patakbuhin", "cal.pause": "I-pause", "cal.delete": "Burahin",
  "cal.note": "Nota", "cal.nothing": "walang naka-iskedyul",
  "notice.reminder": "Paalala", "notice.brief": "Buod", "notice.review": "Pagsusuri",
  "notice.research": "Pananaliksik", "notice.view": "i-click para tingnan", "notice.dismiss": "Isara",
  "reader.saveAs": "I-save bilang nota", "reader.openNote": "Buksan ang nota", "reader.close": "Isara",
  "set.language": "Wika", "set.save": "I-save at subukan", "set.test": "Subukan", "set.close": "Isara",
  "skills.history": "Kasaysayan", "skills.newSticky": "Bagong sticky note",
};

const DICTS: Record<string, Dict> = { en, es, fr, de, pt, it, nl, ru, tr, ar, zh, ja, ko, fil };

export const LANGS: Array<[string, string]> = [
  ["en", "English (United States)"],
  ["es", "Español"],
  ["fr", "Français"],
  ["de", "Deutsch"],
  ["pt", "Português"],
  ["it", "Italiano"],
  ["nl", "Nederlands"],
  ["ru", "Русский"],
  ["tr", "Türkçe"],
  ["ar", "العربية"],
  ["zh", "中文"],
  ["ja", "日本語"],
  ["ko", "한국어"],
  ["fil", "Filipino"],
];

let lang = "en";

export function currentLang(): string {
  return lang;
}

export function t(key: string): string {
  return DICTS[lang]?.[key] ?? en[key] ?? key;
}

export function setLang(next: string) {
  lang = DICTS[next] ? next : "en";
  document.documentElement.lang = lang;
  applyI18n();
}

export function applyI18n() {
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => {
    const key = el.dataset.i18nTitle;
    if (key) el.title = t(key);
  });
}

export function initI18n(saved: string, detected: string) {
  const pick = saved || detected.split(/[-_]/)[0] || "en";
  setLang(pick);
  return lang;
}

const extra: Record<string, Dict> = {
  en: { "file.menu": "File", "cal.fOnce": "Once (this date)", "cal.fDaily": "Every day", "cal.fWeekly": "Every week (this weekday)", "cal.fMonthly": "Every month (this day)", "cal.fWeekdays": "Weekdays (Mon–Fri)", "cal.aBrief": "Brief", "cal.aReview": "Review", "cal.aRemind": "Remind", "cal.aResearch": "Research", "cal.aPrompt": "Custom prompt", "cal.aAsk": "Ask (?)" },
  es: { "file.menu": "Archivo", "cal.fOnce": "Una vez (esta fecha)", "cal.fDaily": "Todos los días", "cal.fWeekly": "Cada semana (este día)", "cal.fMonthly": "Cada mes (este día)", "cal.fWeekdays": "Días laborables (lun–vie)", "cal.aBrief": "Resumen", "cal.aReview": "Revisión", "cal.aRemind": "Recordar", "cal.aResearch": "Investigación", "cal.aPrompt": "Indicación personalizada", "cal.aAsk": "Preguntar (?)" },
  fr: { "file.menu": "Fichier", "cal.fOnce": "Une fois (cette date)", "cal.fDaily": "Chaque jour", "cal.fWeekly": "Chaque semaine (ce jour)", "cal.fMonthly": "Chaque mois (ce jour)", "cal.fWeekdays": "Jours ouvrés (lun–ven)", "cal.aBrief": "Résumé", "cal.aReview": "Bilan", "cal.aRemind": "Rappel", "cal.aResearch": "Recherche", "cal.aPrompt": "Instruction personnalisée", "cal.aAsk": "Demander (?)" },
  de: { "file.menu": "Datei", "cal.fOnce": "Einmal (dieses Datum)", "cal.fDaily": "Jeden Tag", "cal.fWeekly": "Jede Woche (dieser Wochentag)", "cal.fMonthly": "Jeden Monat (dieser Tag)", "cal.fWeekdays": "Werktage (Mo–Fr)", "cal.aBrief": "Bericht", "cal.aReview": "Rückblick", "cal.aRemind": "Erinnern", "cal.aResearch": "Recherche", "cal.aPrompt": "Eigene Anweisung", "cal.aAsk": "Fragen (?)" },
  pt: { "file.menu": "Arquivo", "cal.fOnce": "Uma vez (esta data)", "cal.fDaily": "Todos os dias", "cal.fWeekly": "Toda semana (este dia)", "cal.fMonthly": "Todo mês (este dia)", "cal.fWeekdays": "Dias úteis (seg–sex)", "cal.aBrief": "Resumo", "cal.aReview": "Revisão", "cal.aRemind": "Lembrar", "cal.aResearch": "Pesquisa", "cal.aPrompt": "Instrução personalizada", "cal.aAsk": "Perguntar (?)" },
  it: { "file.menu": "File", "cal.fOnce": "Una volta (questa data)", "cal.fDaily": "Ogni giorno", "cal.fWeekly": "Ogni settimana (questo giorno)", "cal.fMonthly": "Ogni mese (questo giorno)", "cal.fWeekdays": "Giorni feriali (lun–ven)", "cal.aBrief": "Riepilogo", "cal.aReview": "Revisione", "cal.aRemind": "Promemoria", "cal.aResearch": "Ricerca", "cal.aPrompt": "Istruzione personalizzata", "cal.aAsk": "Chiedi (?)" },
  nl: { "file.menu": "Bestand", "cal.fOnce": "Eenmalig (deze datum)", "cal.fDaily": "Elke dag", "cal.fWeekly": "Elke week (deze dag)", "cal.fMonthly": "Elke maand (deze dag)", "cal.fWeekdays": "Werkdagen (ma–vr)", "cal.aBrief": "Overzicht", "cal.aReview": "Terugblik", "cal.aRemind": "Herinneren", "cal.aResearch": "Onderzoek", "cal.aPrompt": "Eigen opdracht", "cal.aAsk": "Vragen (?)" },
  ru: { "file.menu": "Файл", "cal.fOnce": "Один раз (эта дата)", "cal.fDaily": "Каждый день", "cal.fWeekly": "Каждую неделю (этот день)", "cal.fMonthly": "Каждый месяц (этот день)", "cal.fWeekdays": "Будни (пн–пт)", "cal.aBrief": "Сводка", "cal.aReview": "Обзор", "cal.aRemind": "Напомнить", "cal.aResearch": "Исследование", "cal.aPrompt": "Своя инструкция", "cal.aAsk": "Спросить (?)" },
  tr: { "file.menu": "Dosya", "cal.fOnce": "Bir kez (bu tarih)", "cal.fDaily": "Her gün", "cal.fWeekly": "Her hafta (bu gün)", "cal.fMonthly": "Her ay (bu gün)", "cal.fWeekdays": "Hafta içi (Pzt–Cum)", "cal.aBrief": "Özet", "cal.aReview": "Değerlendirme", "cal.aRemind": "Hatırlat", "cal.aResearch": "Araştırma", "cal.aPrompt": "Özel komut", "cal.aAsk": "Sor (?)" },
  ar: { "file.menu": "ملف", "cal.fOnce": "مرة واحدة (هذا التاريخ)", "cal.fDaily": "كل يوم", "cal.fWeekly": "كل أسبوع (هذا اليوم)", "cal.fMonthly": "كل شهر (هذا اليوم)", "cal.fWeekdays": "أيام العمل (الإثنين–الجمعة)", "cal.aBrief": "موجز", "cal.aReview": "مراجعة", "cal.aRemind": "تذكير", "cal.aResearch": "بحث", "cal.aPrompt": "أمر مخصص", "cal.aAsk": "اسأل (؟)" },
  zh: { "file.menu": "文件", "cal.fOnce": "一次（此日期）", "cal.fDaily": "每天", "cal.fWeekly": "每周（此星期）", "cal.fMonthly": "每月（此日）", "cal.fWeekdays": "工作日（周一至周五）", "cal.aBrief": "简报", "cal.aReview": "回顾", "cal.aRemind": "提醒", "cal.aResearch": "研究", "cal.aPrompt": "自定义提示", "cal.aAsk": "提问（?）" },
  ja: { "file.menu": "ファイル", "cal.fOnce": "1回（この日付）", "cal.fDaily": "毎日", "cal.fWeekly": "毎週（この曜日）", "cal.fMonthly": "毎月（この日）", "cal.fWeekdays": "平日（月〜金）", "cal.aBrief": "ブリーフ", "cal.aReview": "レビュー", "cal.aRemind": "リマインダー", "cal.aResearch": "リサーチ", "cal.aPrompt": "カスタム指示", "cal.aAsk": "質問（?）" },
  ko: { "file.menu": "파일", "cal.fOnce": "한 번 (이 날짜)", "cal.fDaily": "매일", "cal.fWeekly": "매주 (이 요일)", "cal.fMonthly": "매월 (이 날짜)", "cal.fWeekdays": "평일 (월–금)", "cal.aBrief": "브리핑", "cal.aReview": "리뷰", "cal.aRemind": "알림", "cal.aResearch": "리서치", "cal.aPrompt": "사용자 지정 프롬프트", "cal.aAsk": "질문 (?)" },
  fil: { "file.menu": "File", "cal.fOnce": "Isang beses (petsang ito)", "cal.fDaily": "Araw-araw", "cal.fWeekly": "Linggo-linggo (araw na ito)", "cal.fMonthly": "Buwan-buwan (araw na ito)", "cal.fWeekdays": "Mga araw ng trabaho (Lun–Biy)", "cal.aBrief": "Buod", "cal.aReview": "Pagsusuri", "cal.aRemind": "Paalala", "cal.aResearch": "Pananaliksik", "cal.aPrompt": "Custom na utos", "cal.aAsk": "Itan (?)" },
};

for (const code of Object.keys(extra)) {
  Object.assign(DICTS[code], extra[code]);
}

export async function bootstrapLang(): Promise<string> {
  try {
    const prefs = await invoke<{ language: string }>("settings_get");
    const detected = await invoke<string>("detect_locale").catch(() => "en");
    const pick = prefs.language || detected.split(/[-_]/)[0] || "en";
    setLang(pick);
    return pick;
  } catch {
    return lang;
  }
}

const extra2: Record<string, Dict> = {
  en: { "skill.new": "New skill", "skill.edit": "Edit skill", "skill.name": "Name", "skill.description": "Description", "skill.triggers": "Use when — words or requests that should trigger it", "skill.knowledge": "Knowledge & examples the AI applies — ratios, rules, Q→A pairs", "skill.steps": "Steps — one per line (optional actions to run)", "skill.sample": "Insert sample", "skill.search": "Search skills…", "skill.help": "Knowledge sections teach the AI — it recalls them in chat when a request matches. Steps are actions Laido runs: @research topic, prompt: instruction, ? question, remind: text, brief, review." },
  es: { "skill.new": "Nueva habilidad", "skill.edit": "Editar habilidad", "skill.name": "Nombre", "skill.description": "Descripción", "skill.triggers": "Usar cuando — palabras o peticiones que la activan", "skill.knowledge": "Conocimiento y ejemplos que la IA aplica — ratios, reglas, pares P→R", "skill.steps": "Pasos — uno por línea (acciones opcionales)", "skill.sample": "Insertar ejemplo", "skill.search": "Buscar habilidades…", "skill.help": "Las secciones de conocimiento enseñan a la IA. Los pasos son acciones: @research tema, prompt: instrucción, ? pregunta, remind: texto, brief, review." },
  fr: { "skill.new": "Nouvelle compétence", "skill.edit": "Modifier la compétence", "skill.name": "Nom", "skill.description": "Description", "skill.triggers": "Utiliser quand — mots ou demandes déclencheurs", "skill.knowledge": "Connaissances et exemples que l'IA applique — ratios, règles, paires Q→R", "skill.steps": "Étapes — une par ligne (actions facultatives)", "skill.sample": "Insérer un exemple", "skill.search": "Rechercher des compétences…", "skill.help": "Les sections de connaissance enseignent l'IA. Les étapes sont des actions : @research sujet, prompt: instruction, ? question, remind: texte, brief, review." },
  de: { "skill.new": "Neue Fähigkeit", "skill.edit": "Fähigkeit bearbeiten", "skill.name": "Name", "skill.description": "Beschreibung", "skill.triggers": "Verwenden wenn — Wörter oder Anfragen, die sie auslösen", "skill.knowledge": "Wissen & Beispiele, die die KI anwendet — Verhältnisse, Regeln, F→A-Paare", "skill.steps": "Schritte — einer pro Zeile (optionale Aktionen)", "skill.sample": "Beispiel einfügen", "skill.search": "Fähigkeiten suchen…", "skill.help": "Wissensabschnitte bringen der KI etwas bei. Schritte sind Aktionen: @research Thema, prompt: Anweisung, ? Frage, remind: Text, brief, review." },
  pt: { "skill.new": "Nova habilidade", "skill.edit": "Editar habilidade", "skill.name": "Nome", "skill.description": "Descrição", "skill.triggers": "Usar quando — palavras ou pedidos que a acionam", "skill.knowledge": "Conhecimento e exemplos que a IA aplica — razões, regras, pares P→R", "skill.steps": "Passos — um por linha (ações opcionais)", "skill.sample": "Inserir exemplo", "skill.search": "Buscar habilidades…", "skill.help": "Seções de conhecimento ensinam a IA. Passos são ações: @research tema, prompt: instrução, ? pergunta, remind: texto, brief, review." },
  it: { "skill.new": "Nuova competenza", "skill.edit": "Modifica competenza", "skill.name": "Nome", "skill.description": "Descrizione", "skill.triggers": "Usa quando — parole o richieste che la attivano", "skill.knowledge": "Conoscenza ed esempi che l'IA applica — rapporti, regole, coppie D→R", "skill.steps": "Passaggi — uno per riga (azioni opzionali)", "skill.sample": "Inserisci esempio", "skill.search": "Cerca competenze…", "skill.help": "Le sezioni di conoscenza insegnano all'IA. I passaggi sono azioni: @research tema, prompt: istruzione, ? domanda, remind: testo, brief, review." },
  nl: { "skill.new": "Nieuwe vaardigheid", "skill.edit": "Vaardigheid bewerken", "skill.name": "Naam", "skill.description": "Beschrijving", "skill.triggers": "Gebruiken wanneer — woorden of verzoeken die het activeren", "skill.knowledge": "Kennis & voorbeelden die de AI toepast — verhoudingen, regels, V→A-paren", "skill.steps": "Stappen — één per regel (optionele acties)", "skill.sample": "Voorbeeld invoegen", "skill.search": "Vaardigheden zoeken…", "skill.help": "Kennissecties leren de AI. Stappen zijn acties: @research onderwerp, prompt: instructie, ? vraag, remind: tekst, brief, review." },
  ru: { "skill.new": "Новый навык", "skill.edit": "Изменить навык", "skill.name": "Название", "skill.description": "Описание", "skill.triggers": "Использовать когда — слова или запросы, которые его вызывают", "skill.knowledge": "Знания и примеры для ИИ — пропорции, правила, пары В→О", "skill.steps": "Шаги — по одному в строке (необязательные действия)", "skill.sample": "Вставить пример", "skill.search": "Поиск навыков…", "skill.help": "Разделы знаний обучают ИИ. Шаги — действия: @research тема, prompt: инструкция, ? вопрос, remind: текст, brief, review." },
  tr: { "skill.new": "Yeni yetenek", "skill.edit": "Yetenek düzenle", "skill.name": "Ad", "skill.description": "Açıklama", "skill.triggers": "Ne zaman kullanılır — tetikleyen kelimeler veya istekler", "skill.knowledge": "AI'nın uyguladığı bilgi ve örnekler — oranlar, kurallar, S→C çiftleri", "skill.steps": "Adımlar — her satıra bir (isteğe bağlı eylemler)", "skill.sample": "Örnek ekle", "skill.search": "Yetenek ara…", "skill.help": "Bilgi bölümleri AI'a öğretir. Adımlar eylemlerdir: @research konu, prompt: talimat, ? soru, remind: metin, brief, review." },
  ar: { "skill.new": "مهارة جديدة", "skill.edit": "تعديل المهارة", "skill.name": "الاسم", "skill.description": "الوصف", "skill.triggers": "تُستخدم عند — كلمات أو طلبات تفعّلها", "skill.knowledge": "المعرفة والأمثلة التي يطبقها الذكاء — نسب وقواعد وأزواج س→ج", "skill.steps": "الخطوات — سطر لكل خطوة (إجراءات اختيارية)", "skill.sample": "إدراج نموذج", "skill.search": "ابحث عن المهارات…", "skill.help": "أقسام المعرفة تعلّم الذكاء. الخطوات إجراءات: @research موضوع، prompt: تعليمات، ? سؤال، remind: نص، brief، review." },
  zh: { "skill.new": "新技能", "skill.edit": "编辑技能", "skill.name": "名称", "skill.description": "描述", "skill.triggers": "何时使用 — 应触发它的词语或请求", "skill.knowledge": "AI 应用的知识与示例 — 比例、规则、问→答对", "skill.steps": "步骤 — 每行一个（可选动作）", "skill.sample": "插入示例", "skill.search": "搜索技能…", "skill.help": "知识部分教会 AI。步骤是动作：@research 主题、prompt: 指示、? 问题、remind: 文本、brief、review。" },
  ja: { "skill.new": "新しいスキル", "skill.edit": "スキルを編集", "skill.name": "名前", "skill.description": "説明", "skill.triggers": "使うとき — 起動する言葉やリクエスト", "skill.knowledge": "AIが適用する知識と例 — 比率、ルール、Q→Aペア", "skill.steps": "ステップ — 1行に1つ（任意のアクション）", "skill.sample": "サンプルを挿入", "skill.search": "スキルを検索…", "skill.help": "知識セクションはAIに教えます。ステップはアクション：@research トピック、prompt: 指示、? 質問、remind: テキスト、brief、review。" },
  ko: { "skill.new": "새 스킬", "skill.edit": "스킬 편집", "skill.name": "이름", "skill.description": "설명", "skill.triggers": "사용 시점 — 이를 실행할 단어나 요청", "skill.knowledge": "AI가 적용하는 지식과 예시 — 비율, 규칙, Q→A 쌍", "skill.steps": "단계 — 한 줄에 하나(선택적 동작)", "skill.sample": "예시 삽입", "skill.search": "스킬 검색…", "skill.help": "지식 섹션은 AI를 가르칩니다. 단계는 동작입니다: @research 주제, prompt: 지시, ? 질문, remind: 텍스트, brief, review." },
  fil: { "skill.new": "Bagong kasanayan", "skill.edit": "I-edit ang kasanayan", "skill.name": "Pangalan", "skill.description": "Paglalarawan", "skill.triggers": "Gamitin kapag — mga salita o kahilingan na magti-trigger", "skill.knowledge": "Kaalaman at halimbawa na gagamitin ng AI — ratio, rules, T→S pairs", "skill.steps": "Mga hakbang — isa bawat linya (opsyonal na aksyon)", "skill.sample": "Maglagay ng halimbawa", "skill.search": "Maghanap ng kasanayan…", "skill.help": "Ang knowledge sections ay nagtuturo sa AI. Ang mga hakbang ay aksyon: @research paksa, prompt: utos, ? tanong, remind: teksto, brief, review." },
};

for (const code of Object.keys(extra2)) {
  Object.assign(DICTS[code], extra2[code]);
}

const extra3: Record<string, Dict> = {
  en: { "lib.title": "Library", "lib.notes": "Note files", "lib.files": "All files", "lib.attach": "attach files to this note", "lib.drop": "Drop files here", "lib.browse": "Browse…" },
  es: { "lib.title": "Biblioteca", "lib.notes": "Archivos de la nota", "lib.files": "Todos los archivos", "lib.attach": "adjuntar archivos a esta nota", "lib.drop": "Suelta archivos aquí", "lib.browse": "Examinar…" },
  fr: { "lib.title": "Bibliothèque", "lib.notes": "Fichiers de la note", "lib.files": "Tous les fichiers", "lib.attach": "joindre des fichiers à cette note", "lib.drop": "Déposez des fichiers ici", "lib.browse": "Parcourir…" },
  de: { "lib.title": "Bibliothek", "lib.notes": "Dateien der Notiz", "lib.files": "Alle Dateien", "lib.attach": "Dateien an diese Notiz anhängen", "lib.drop": "Dateien hier ablegen", "lib.browse": "Durchsuchen…" },
  pt: { "lib.title": "Biblioteca", "lib.notes": "Ficheiros da nota", "lib.files": "Todos os ficheiros", "lib.attach": "anexar ficheiros a esta nota", "lib.drop": "Solte arquivos aqui", "lib.browse": "Procurar…" },
  it: { "lib.title": "Libreria", "lib.notes": "File della nota", "lib.files": "Tutti i file", "lib.attach": "allega file a questa nota", "lib.drop": "Trascina i file qui", "lib.browse": "Sfoglia…" },
  nl: { "lib.title": "Bibliotheek", "lib.notes": "Bestanden bij notitie", "lib.files": "Alle bestanden", "lib.attach": "voeg bestanden toe aan deze notitie", "lib.drop": "Sleep bestanden hierheen", "lib.browse": "Bladeren…" },
  ru: { "lib.title": "Библиотека", "lib.notes": "Файлы заметки", "lib.files": "Все файлы", "lib.attach": "прикрепить файлы к этой заметке", "lib.drop": "Перетащите файлы сюда", "lib.browse": "Обзор…" },
  tr: { "lib.title": "Kitaplık", "lib.notes": "Not dosyaları", "lib.files": "Tüm dosyalar", "lib.attach": "bu nota dosya ekle", "lib.drop": "Dosyaları buraya bırakın", "lib.browse": "Gözat…" },
  ar: { "lib.title": "المكتبة", "lib.notes": "ملفات الملاحظة", "lib.files": "كل الملفات", "lib.attach": "إرفاق ملفات بهذه الملاحظة", "lib.drop": "أفلت الملفات هنا", "lib.browse": "تصفح…" },
  zh: { "lib.title": "资料库", "lib.notes": "笔记文件", "lib.files": "全部文件", "lib.attach": "附加文件到此笔记", "lib.drop": "将文件拖到此处", "lib.browse": "浏览…" },
  ja: { "lib.title": "ライブラリ", "lib.notes": "ノートのファイル", "lib.files": "すべてのファイル", "lib.attach": "このノートにファイルを添付", "lib.drop": "ここにファイルをドロップ", "lib.browse": "参照…" },
  ko: { "lib.title": "라이브러리", "lib.drop": "여기에 파일을 놓으세요", "lib.browse": "찾아보기…" },
  fil: { "lib.title": "Aklatan", "lib.drop": "Ihulog ang mga file dito", "lib.browse": "Mag-browse…" },
};

for (const code of Object.keys(extra3)) {
  Object.assign(DICTS[code], extra3[code]);
}

const extra4: Record<string, Dict> = {
  en: { "pin.options": "Pin options — color or remove", "pin.remove": "Remove pin" },
  es: { "pin.options": "Opciones del pin — color o quitar", "pin.remove": "Quitar pin" },
  fr: { "pin.options": "Options de l'épingle — couleur ou retirer", "pin.remove": "Retirer l'épingle" },
  de: { "pin.options": "Pin-Optionen — Farbe oder entfernen", "pin.remove": "Pin entfernen" },
  pt: { "pin.options": "Opções do pin — cor ou remover", "pin.remove": "Remover pin" },
  it: { "pin.options": "Opzioni spilla — colore o rimuovi", "pin.remove": "Rimuovi spilla" },
  nl: { "pin.options": "Pin-opties — kleur of verwijderen", "pin.remove": "Pin verwijderen" },
  ru: { "pin.options": "Настройки булавки — цвет или убрать", "pin.remove": "Убрать булавку" },
  tr: { "pin.options": "İğne seçenekleri — renk veya kaldır", "pin.remove": "İğneyi kaldır" },
  ar: { "pin.options": "خيارات الدبوس — اللون أو الإزالة", "pin.remove": "إزالة الدبوس" },
  zh: { "pin.options": "图钉选项 — 颜色或移除", "pin.remove": "移除图钉" },
  ja: { "pin.options": "ピンの設定 — 色または削除", "pin.remove": "ピンを外す" },
  ko: { "pin.options": "핀 옵션 — 색상 또는 제거", "pin.remove": "핀 제거" },
  fil: { "pin.options": "Mga opsyon ng pin — kulay o alisin", "pin.remove": "Alisin ang pin" },
};

for (const code of Object.keys(extra4)) {
  Object.assign(DICTS[code], extra4[code]);
}
