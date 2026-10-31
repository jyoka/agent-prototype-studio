## 既定の素材の指針

見た目の依頼に別の指定がなければ、次の既定の素材で作ってください。文は Studio が自分の言葉でまとめたものです。

- import できる名前: @radix-ui/themes と @radix-ui/themes/styles.css(部品)、@radix-ui/colors と @radix-ui/colors/<色>.css(色。例: blue.css、blue-dark.css、blue-alpha.css)、lucide-react(アイコン)。これらの中のファイルや、radix-ui、@radix-ui/react-* は import できません。
- 使い始め: 入口で import "@radix-ui/themes/styles.css" を読み、画面全体を <Theme> で包みます。

部品の選び方:
- まず @radix-ui/themes の部品を使います。押す操作は Button、アイコンだけなら IconButton と aria-label。入力は TextField、TextArea、Select、Checkbox、RadioGroup、Switch。まとまりは Card、Table。確かめは Dialog、AlertDialog。
- 配置は Flex、Grid、Box、Container。字は Heading、Text。同じ部品を自前で作り直さないでください。
- アイコンは lucide-react から名前で import します。飾りでないアイコンには、隣に文を置くか aria-label を付けます。

色の役割:
- <Theme> の accentColor で押せる所の色を、grayColor で地と線の色を決めます。値のまま書かず、変数を使います。地は var(--color-background)、面は var(--color-panel-solid)、線は var(--gray-6)、字は var(--gray-12)、弱い字は var(--gray-11)、押せる所は var(--accent-9)。
- 失敗は color="red"、注意は color="amber"、成功は color="green" にします。色だけで伝えず、文も添えます。別の色の段が要るときは @radix-ui/colors の CSS を読み、var(--blue-9) のように使います。

字の大きさ:
- 字は OS の字のままにします。字のファイルや Web フォントを足さないでください。外から読むと止まります。
- 大きさは Heading と Text の size で決めます。本文は 2 か 3、小さな注は 1、画面の題は 6 か 7、節の題は 4 か 5 を目安にします。1 つの画面で使う大きさは 3 つか 4 つまでにします。

間隔:
- 余白は値のまま書かず、段(1 から 9)で渡します。間は Flex と Grid の gap、内側は Box、Flex、Grid の p、外側は部品の m です。Card には p を渡さず、中に Flex や Box を置きます。部品の中は 2 か 3、まとまりの間は 4 か 5、節の間は 6 から 8 を目安にします。

アクセシビリティ:
- 入力には見えるラベルを付け、Text as="label" で結びます。Dialog には Dialog.Title を必ず入れ、説明は Dialog.Description で添えます。
- 字と地の差は、本文で 4.5:1 以上を保ちます。var(--gray-11) より薄い色を字に使わないでください。
- 押せる所は 24px 四方以上にします。タブで全部の操作に届き、今どこにいるかが見えるようにします。読み込み中と失敗は文でも知らせます。
