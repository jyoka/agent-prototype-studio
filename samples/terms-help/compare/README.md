# RAG なしの構成(比べるときだけ足す)

`app/` に写すと、RAG なしの構成(`compositions/no-rag.json`)で同じ場面を回せます。約款を読まないので、約款を読む場面は通りません。

```sh
cp -R samples/terms-help/compare/compositions samples/terms-help/compare/mocks samples/terms-help/compare/prompts ~/PrototypeStudio/projects/terms-help/app/
npm run evals -- terms-help --composition composition.json,compositions/no-rag.json
```

`app/` の外に置いたのは、見本のどの構成も場面を全部通す決まり(`test/integration/reuse.test.js`)があるためです。使い方は [docs/usage.md の「文書の検索を試す」](../../../docs/usage.md#文書の検索を試す架空のしおかぜ便の約款)にあります。
