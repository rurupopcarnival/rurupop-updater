// 更新先の一覧。更新先を増やすときはここに追加する（RuruPopPad本体など）。
// allow：ZIPから反映してよいファイル（* は「/」以外の任意の文字）。ここに当てはまらないファイルが入ったZIPは受け付けない。
export const TARGETS = [
  {
    id: 'fates-beta',
    name: '7F7S クローズドβテスト',
    site: 'beta.rurupop.com',
    color: '#5b6cff',
    repo: 'rurupopcarnival/fates-beta',
    branch: 'main',
    allow: ['scenarios/*.txt'],
    allowDelete: true,
    worker: 'fates-beta',
    check: 'fates-scenarios', // 反映前に台本を検証する
  },
];
