import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { activityCalendar, activityDays, parseCalendarDay, type ActivityEntry } from './data';
import { localDay } from './tracker';
import './activity.css';

export interface ActivityHeatmapProps { title: string; entries: ActivityEntry[] }
const number = (value: number) => value.toLocaleString('zh-CN');
const label = (day: string) => parseCalendarDay(day)?.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }) || day;
const level = (count: number) => !count ? 0 : count < 100 ? 1 : count < 500 ? 2 : count < 2000 ? 3 : 4;

export function ActivityHeatmap({ title, entries }: ActivityHeatmapProps) {
  const [today, setToday] = useState(() => localDay());
  const [selected, setSelected] = useState(today);
  useEffect(() => {
    const timer = setInterval(() => setToday(localDay()), 60000);
    return () => clearInterval(timer);
  }, []);
  const calendar = useMemo(() => activityCalendar(today), [today]);
  const totals = useMemo(() => activityDays(entries), [entries]);
  const visible = [...totals.values()].filter(day => day.day >= calendar.start && day.day <= today);
  const activeDays = visible.filter(day => day.added + day.removed > 0).length;
  const added = visible.reduce((sum, day) => sum + day.added, 0), removed = visible.reduce((sum, day) => sum + day.removed, 0);
  const detail = totals.get(selected);
  const months: { column: number; text: string }[] = [];
  let previousMonth = '';
  for (let column = 0; column < calendar.weeks; column++) {
    const day = calendar.days.slice(column * 7, column * 7 + 7).find(day => day && day >= calendar.start);
    const month = day?.slice(0, 7) || '';
    if (month && month !== previousMonth && (!months.length || column - months[months.length - 1].column >= 3)) {
      months.push({ column, text: `${Number(month.slice(5))}月` });
      previousMonth = month;
    }
  }
  return <section className="tp-activity" aria-label={title || '每日打卡'}>
    <header className="tp-activity-heading"><h2>{title || '每日打卡'}</h2><span>近一年 <strong>{activeDays}</strong> 天</span></header>
    <div className="tp-activity-scroll">
      <div className="tp-activity-chart" style={{ '--activity-weeks': calendar.weeks } as CSSProperties}>
        <div className="tp-activity-months" aria-hidden="true">{months.map(month => <span key={month.column} style={{ gridColumn: `${month.column + 1} / span ${Math.min(3, calendar.weeks - month.column)}` }}>{month.text}</span>)}</div>
        <div className="tp-activity-weekdays" aria-hidden="true"><span style={{ gridRow: 2 }}>一</span><span style={{ gridRow: 4 }}>三</span><span style={{ gridRow: 6 }}>五</span></div>
        <div className="tp-activity-cells" aria-label="每日编辑记录">{calendar.days.map((day, index) => {
          if (!day || day < calendar.start) return <span key={`blank-${index}`} className="tp-activity-cell tp-activity-blank" aria-hidden="true" />;
          const activity = totals.get(day), count = (activity?.added || 0) + (activity?.removed || 0);
          const text = `${label(day)}，新增 ${number(activity?.added || 0)} 字，删除 ${number(activity?.removed || 0)} 字`;
          return <button key={day} type="button" className="tp-activity-cell" data-level={level(count)} aria-label={text} aria-pressed={selected === day} title={text} onClick={() => setSelected(day)} />;
        })}</div>
      </div>
    </div>
    <div className="tp-activity-summary"><span><b className="tp-activity-added">+{number(added)}</b><b className="tp-activity-removed">−{number(removed)}</b><span>字</span></span><div className="tp-activity-legend" aria-label="颜色越深，编辑越多"><span>少</span>{[0, 1, 2, 3, 4].map(value => <i key={value} className="tp-activity-cell" data-level={value} />)}<span>多</span></div></div>
    <div className="tp-activity-detail" aria-live="polite">
      <div className="tp-activity-day"><span>{label(selected)}{selected === today ? ' · 今天' : ''}</span><span><b className="tp-activity-added">+{number(detail?.added || 0)}</b><b className="tp-activity-removed">−{number(detail?.removed || 0)}</b></span></div>
      {detail?.documents.some(document => document.added + document.removed > 0) ? <ul>{detail.documents.filter(document => document.added + document.removed > 0).map(document => <li key={document.documentId}><span title={document.title}>{document.title}</span><span><b className="tp-activity-added">+{number(document.added)}</b><b className="tp-activity-removed">−{number(document.removed)}</b></span></li>)}</ul> : <p>暂无编辑记录</p>}
    </div>
  </section>;
}
