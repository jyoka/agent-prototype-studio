// 読み込みは終わるが、その後に止まらないループに入る。観察器は時間切れのエラーにする
document.getElementById('root').textContent = '架空の掲示板';
setTimeout(() => {
  let count = 0;
  while (count >= 0) {
    count = (count + 1) % 1000;
  }
}, 100);
