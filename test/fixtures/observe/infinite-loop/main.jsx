// 読み込みの途中で止まらないループ。観察器は時間切れのエラーにする
let count = 0;
while (count >= 0) {
  count = (count + 1) % 1000;
}
document.getElementById('root').textContent = '架空の時刻表';
