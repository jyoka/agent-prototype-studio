// すべて架空の講座。実在の学校、講座、講師とは関係ない。
// minutes は 1 回の目安(分)。
export const COURSES = [
  { id: 1, name: 'そらいろ英会話 はじめの一歩', subject: '英会話', level: 'はじめて', style: '動画で学ぶ', minutes: 15 },
  { id: 2, name: 'あおぞら英会話サロン', subject: '英会話', level: '少し経験あり', style: '教室に通う', minutes: 60 },
  { id: 3, name: '英語で話す読本', subject: '英会話', level: '少し経験あり', style: '本で学ぶ', minutes: 20 },
  { id: 4, name: 'はじめてのアプリづくり', subject: 'プログラミング', level: 'はじめて', style: '動画で学ぶ', minutes: 30 },
  { id: 5, name: 'くもま式 コードの読み方', subject: 'プログラミング', level: '少し経験あり', style: '本で学ぶ', minutes: 30 },
  { id: 6, name: 'つくって教えるプログラミング教室', subject: 'プログラミング', level: '人に教えられる', style: '教室に通う', minutes: 90 },
  { id: 7, name: 'ひよこ簿記 3 級の入口', subject: '簿記', level: 'はじめて', style: '本で学ぶ', minutes: 20 },
  { id: 8, name: '夜の簿記教室', subject: '簿記', level: '少し経験あり', style: '教室に通う', minutes: 60 },
  { id: 9, name: 'まちかど写真さんぽ', subject: '写真', level: 'はじめて', style: '教室に通う', minutes: 45 },
  { id: 10, name: 'ひかりの写真動画講座', subject: '写真', level: '少し経験あり', style: '動画で学ぶ', minutes: 15 },
];

// 決まっている項目だけで絞る。未定(null)の項目は問わない。時間は 1 回の目安が使える時間に収まるもの
export function matchCourses(state) {
  return COURSES.filter(
    (course) =>
      (state.subject == null || course.subject === state.subject) &&
      (state.level == null || course.level === state.level) &&
      (state.style == null || course.style === state.style) &&
      (state.minutes == null || course.minutes <= state.minutes),
  );
}

// 1 週間の進め方。毎日の時間を、講座の 1 回の長さで割る
export function weeklyPlan(state, course) {
  if (state.minutes == null || !course) return null;
  const perDay = Math.max(1, Math.floor(state.minutes / course.minutes));
  return { perDay, perWeek: perDay * 7, totalMinutes: state.minutes * 7 };
}
