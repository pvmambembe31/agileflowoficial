# AgileFlow 1.0 Stable

Build estável do AgileFlow. O mesmo conteúdo pode ser publicado no **Netlify** ou no **GitHub Pages**.

## Persistência
- Chave do navegador preservada: `agileflow.v01`.
- Schema de dados: 17.
- Compatível com Local Bridge protocol 1.
- Dados reais continuam locais em `Documents/AgileFlow` quando Local-first está ativo.

## Netlify
Faça deploy do conteúdo da raiz deste pacote.

## GitHub Pages
1. Crie um repositório público (necessário no GitHub Free para Pages).
2. Envie todos os arquivos deste pacote para a raiz do repositório.
3. Em Settings > Pages, selecione **GitHub Actions** como source.
4. O workflow `.github/workflows/pages.yml` publica automaticamente.

## Dual host
O launcher Stable pode preferir Netlify e usar GitHub Pages como fallback. Configure a URL do GitHub Pages no pacote do Bridge/Launcher Stable.
