// すべて架空の求人。実在の企業、店舗、地名とは関係ない。
// wage は時給(正社員と契約社員は時給に換算した目安)。
export const JOBS = [
  { id: 1, name: '喫茶こもれび', jobType: 'カフェのホール', employmentType: 'アルバイト・パート', area: 'しおかぜ町', wage: 1100 },
  { id: 2, name: 'カフェ海猫', jobType: 'カフェのホール', employmentType: 'アルバイト・パート', area: 'もみじ台', wage: 1150 },
  { id: 3, name: 'ひばり珈琲店', jobType: 'カフェのホール', employmentType: '正社員', area: 'ひばり駅前', wage: 1350 },
  { id: 4, name: '波音書店', jobType: '書店の売り場', employmentType: 'アルバイト・パート', area: 'しおかぜ町', wage: 1050 },
  { id: 5, name: 'もみじ台ブックス', jobType: '書店の売り場', employmentType: '契約社員', area: 'もみじ台', wage: 1200 },
  { id: 6, name: 'しおかぜ物流センター', jobType: '倉庫の仕分け', employmentType: 'アルバイト・パート', area: 'しおかぜ町', wage: 1200 },
  { id: 7, name: 'ひばり倉庫', jobType: '倉庫の仕分け', employmentType: '契約社員', area: 'ひばり駅前', wage: 1250 },
  { id: 8, name: 'もみじ台くらしの窓口', jobType: '事務', employmentType: '正社員', area: 'もみじ台', wage: 1300 },
  { id: 9, name: 'ひばり駅前オフィス', jobType: '事務', employmentType: 'アルバイト・パート', area: 'ひばり駅前', wage: 1150 },
];

// 決まっている条件だけで絞る。未定(null)の条件は問わない
export function matchJobs(state) {
  return JOBS.filter(
    (job) =>
      (state.jobType == null || job.jobType === state.jobType) &&
      (state.employmentType == null || job.employmentType === state.employmentType) &&
      (state.area == null || job.area === state.area) &&
      (state.wage == null || job.wage >= state.wage),
  );
}
