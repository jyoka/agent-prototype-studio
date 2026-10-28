document.getElementById('root').textContent = '架空の天気予報';
// だれも受け取らない reject
Promise.reject(new Error('架空の天気の取り込みに失敗しました'));
