import { MarkdownView, Plugin, TFile } from "obsidian";
import {
  Decoration,
  DecorationSet,
  WidgetType,
  EditorView,
} from "@codemirror/view";
import { StateField, StateEffect, RangeSetBuilder, EditorState } from "@codemirror/state";

/** 扫描完成后广播, 让所有编辑器的周历 widget 重建 */
const weekCalRefresh = StateEffect.define<null>();

/* ------------------------------------------------------------------ */
/* 语法解析: week：2026.09.03 本周的简短介绍                            */
/* ------------------------------------------------------------------ */

const WEEK_RE =
  /^week\s*[：:]\s*(\d{4})\s*[.．]\s*(\d{1,2})\s*[.．]\s*(\d{1,2})(?:\s+(.*))?$/i;

const WEEK_CN = ["一", "二", "三", "四", "五", "六"];

interface WeekData {
  year: number;
  month: number;
  week: number;
  intro: string;
}

function parseWeekLine(text: string): WeekData | null {
  const m = WEEK_RE.exec(text.trim());
  if (!m) return null;
  const year = +m[1];
  const month = +m[2];
  const week = +m[3];
  if (month < 1 || month > 12 || week < 1 || week > 6) return null;
  return { year, month, week, intro: (m[4] || "").trim() };
}

/* ------------------------------------------------------------------ */
/* 日期工具                                                            */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? "0" + n : String(n);
}

function weekCn(w: number): string {
  return w >= 1 && w <= WEEK_CN.length ? WEEK_CN[w - 1] : String(w);
}

/** 该月第 1 周的周一(以包含当月 1 号的那一周为第 1 周, 周一为一周起点) */
function week1Monday(year: number, month: number): Date {
  const first = new Date(year, month - 1, 1);
  const dow = (first.getDay() + 6) % 7; // 0 = 周一
  const monday = new Date(first);
  monday.setDate(first.getDate() - dow);
  return monday;
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

/* ------------------------------------------------------------------ */
/* 表格构建                                                            */
/* ------------------------------------------------------------------ */

function weekKey(year: number, month: number, week: number): string {
  return `${year}-${month}-${week}`;
}

function buildTable(data: WeekData, introMap: Map<string, string>): HTMLElement {
  const table = document.createElement("table");
  table.addClass("week-cal-table");

  // 第 1 行: 2026年09月-第三周-简介 (整行不分割)
  const titleRow = table.createEl("tr");
  const title = titleRow.createEl("th", { attr: { colspan: "8" } });
  title.addClass("week-cal-title");
  title.setText(`${data.year}年${pad2(data.month)}月-第${weekCn(data.week)}周-${data.intro}`);

  // 第 2 行: 一 ~ 日 + 简介列空表头
  const dayRow = table.createEl("tr");
  for (const d of ["一", "二", "三", "四", "五", "六", "日"]) {
    const th = dayRow.createEl("th");
    th.setText(d);
    th.addClass("week-cal-day-head");
  }
  const introHead = dayRow.createEl("th");
  introHead.addClass("week-cal-intro-head");

  // 第 3~5 行: 上一周 / 本周 / 下一周日期
  const startWeek = Math.max(1, data.week - 1);
  // 右侧简介列: 从上到下固定为 第 W-2 周 → 第 W 周 (不足三周从第一格排起)
  const introStart = Math.max(1, data.week - 2);
  const w1 = week1Monday(data.year, data.month);

  for (let i = 0; i < 3; i++) {
    const k = startWeek + i;
    const tr = table.createEl("tr");
    if (k === data.week) tr.addClass("week-cal-current");

    const monday = addDays(w1, (k - 1) * 7);
    for (let j = 0; j < 7; j++) {
      const day = addDays(monday, j);
      const td = tr.createEl("td");
      td.addClass("week-cal-date");
      // 跨月日期只显示日号, 用灰色区分
      if (day.getMonth() + 1 !== data.month) td.addClass("week-cal-other-month");
      td.setText(String(day.getDate()));
    }

    // 简介列
    const introTd = tr.createEl("td");
    introTd.addClass("week-cal-intro");
    const intro = introMap.get(weekKey(data.year, data.month, introStart + i));
    if (intro) introTd.setText(intro);
  }

  return table;
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

export default class WeekCalendarPlugin extends Plugin {
  introMap: Map<string, string> = new Map();
  mapVersion = 0;
  private scanTimer: number | null = null;

  async onload() {
    await this.refreshIntroMap();

    // Live Preview (实时预览) 模式
    this.registerEditorExtension(makeEditorExtension(this));

    // 阅读模式
    this.registerMarkdownPostProcessor((el) => this.processReading(el));

    // 打开笔记时, 若光标停在 week 行(会显示源码), 自动下移到下一行
    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        // 编辑器内容与光标位置在 file-open 之后才恢复,
        // 因此分几次检查; 一旦光标已不在 week 行就停止
        for (const delay of [60, 180, 350]) {
          window.setTimeout(() => this.moveCursorBelowWeekLine(file), delay);
        }
      })
    );

    // 笔记变动后延迟刷新简介缓存
    const rescan = () => {
      if (this.scanTimer) window.clearTimeout(this.scanTimer);
      this.scanTimer = window.setTimeout(() => {
        void this.refreshIntroMap().then(() => this.pushRefresh());
      }, 1000);
    };
    this.registerEvent(this.app.vault.on("modify", rescan));
    this.registerEvent(this.app.vault.on("delete", rescan));
    this.registerEvent(this.app.vault.on("rename", rescan));
  }

  /** 若当前光标停在 week 行, 把它移到该行下方(行首); 已是最后一行则移到行尾 */
  private moveCursorBelowWeekLine(expectFile: TFile | null): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) return;
    if (expectFile && view.file !== expectFile) return;

    const ed = view.editor;
    const cur = ed.getCursor();
    const text = ed.getLine(cur.line) ?? "";
    if (!parseWeekLine(text)) return;

    const last = ed.lastLine();
    if (cur.line < last) {
      ed.setCursor({ line: cur.line + 1, ch: 0 });
    } else {
      ed.setCursor({ line: cur.line, ch: text.length });
    }
  }

  /** 扫描完成后, 通知所有打开的编辑器重建周历 widget */
  private pushRefresh(): void {
    const ws = this.app.workspace as unknown as {
      iterateCodeMirrors?: (cb: (cm: EditorView) => void) => void;
      iterateAllViews?: (cb: (view: unknown) => void) => void;
    };
    if (typeof ws.iterateCodeMirrors === "function") {
      ws.iterateCodeMirrors((cm) =>
        cm.dispatch({ effects: weekCalRefresh.of(null) })
      );
    } else if (typeof ws.iterateAllViews === "function") {
      ws.iterateAllViews((view) => {
        const cm = (view as { editor?: { cm?: EditorView } }).editor?.cm;
        if (cm) cm.dispatch({ effects: weekCalRefresh.of(null) });
      });
    }
  }

  /** 扫描全库, 收集每周的简短介绍 (取每篇笔记中第一条 week 行) */
  async refreshIntroMap(): Promise<void> {
    const map = new Map<string, string>();
    for (const file of this.app.vault.getMarkdownFiles()) {
      try {
        const content = await this.app.vault.cachedRead(file);
        for (const line of content.split("\n")) {
          const data = parseWeekLine(line);
          if (data) {
            map.set(weekKey(data.year, data.month, data.week), data.intro);
            break;
          }
        }
      } catch {
        // 读取失败则跳过该文件
      }
    }
    this.introMap = map;
    this.mapVersion++;
  }

  /** 阅读模式: 找到 week 段落, 替换为表格 */
  private processReading(el: HTMLElement): void {
    el.querySelectorAll("p").forEach((p) => {
      const text = (p.textContent || "").trim();
      const data = parseWeekLine(text);
      if (!data) return;
      const wrap = document.createElement("div");
      wrap.addClass("week-cal-widget");
      wrap.addClass("week-cal-static");
      wrap.appendChild(buildTable(data, this.introMap));
      p.replaceWith(wrap);
    });
  }
}

/* ------------------------------------------------------------------ */
/* Live Preview: CodeMirror 6 装饰器                                    */
/* ------------------------------------------------------------------ */

class WeekWidget extends WidgetType {
  constructor(
    readonly data: WeekData,
    readonly plugin: WeekCalendarPlugin,
    readonly pos: number,
    /** 三个简介格内容的快照, 用于 eq 判断是否需要重建 DOM */
    readonly introSnapshot: string
  ) {
    super();
  }

  eq(other: WeekWidget): boolean {
    return (
      other.data.year === this.data.year &&
      other.data.month === this.data.month &&
      other.data.week === this.data.week &&
      other.data.intro === this.data.intro &&
      other.pos === this.pos &&
      other.introSnapshot === this.introSnapshot
    );
  }

  toDOM(view: EditorView): HTMLElement {
    // 用块级包裹层保证表格能在编辑区内水平居中
    // (CM6 会把 widget 放进内联容器, 直接在 table 上写 margin:auto 不生效)
    const wrap = document.createElement("div");
    wrap.addClass("week-cal-widget");
    wrap.appendChild(buildTable(this.data, this.plugin.introMap));
    // 点击表格回到源码行进行编辑
    wrap.addEventListener("mousedown", (ev) => {
      ev.preventDefault();
      view.dispatch({ selection: { anchor: this.pos }, scrollIntoView: true });
    });
    return wrap;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function makeEditorExtension(plugin: WeekCalendarPlugin) {
  // 注意: 替换换行符的 replace 装饰只能由 StateField 提供,
  // ViewPlugin 提供会被 CodeMirror 拒绝 ("Decorations that replace
  // line breaks may not be provided via plugins"), 因此这里用 StateField。
  const buildFieldDeco = (state: EditorState): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const sel = state.selection.main;
    const doc = state.doc;

    for (let i = 1; i <= doc.lines; i++) {
      const line = doc.line(i);
      const data = parseWeekLine(line.text);
      if (!data) continue;

      // 光标在这一行时显示源码, 方便编辑
      if (sel.from <= line.to && sel.to >= line.from) continue;

      // 简介快照 (第 W-2 ~ W 周三格), 变化时才重建 DOM
      const introStart = Math.max(1, data.week - 2);
      const snapshot = [0, 1, 2]
        .map((i) => plugin.introMap.get(weekKey(data.year, data.month, introStart + i)) ?? "")
        .join("|");

      // 隐藏整行(含换行符), 避免留下空行
      const to = line.to < doc.length ? line.to + 1 : line.to;
      builder.add(
        line.from,
        to,
        Decoration.replace({
          widget: new WeekWidget(data, plugin, line.from, snapshot),
          block: true,
        })
      );
    }
    return builder.finish();
  };

  return StateField.define<DecorationSet>({
    create(state) {
      return buildFieldDeco(state);
    },
    update(value, tr) {
      if (
        tr.docChanged ||
        tr.selection ||
        tr.effects.some((e) => e.is(weekCalRefresh))
      ) {
        return buildFieldDeco(tr.state);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
