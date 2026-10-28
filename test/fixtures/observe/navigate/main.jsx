// 読み込みの途中で、自分で別のページへ移る。移った先には Studio の runtime がない
document.getElementById('root').textContent = '架空の案内板';
window.location.href = './elsewhere.html';
