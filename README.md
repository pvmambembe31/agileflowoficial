# AgileFlow 1.1 — servidor Debian

O servidor Debian é a fonte principal dos projetos. O navegador abre o WebApp, lê `/api/v1/workspace` e grava alterações no mesmo servidor. Os arquivos ficam em `/srv/agileflow`; o aplicativo não usa o Bridge nem o armazenamento do navegador para guardar a versão principal.

## Publicação

1. Atualize a API e o atualizador do Debian com os arquivos em `server/` e o instalador `server/install_server_only.sh`. Faça isso **antes** de publicar a versão 1.1 no GitHub.
2. Envie os arquivos e pastas deste pacote, extraídos na raiz de `pvmambembe31/agileflowoficial` na branch `main`. O arquivo ZIP isolado não publica o aplicativo.
3. O timer do Debian verifica o GitHub a cada 30 minutos. Para aplicar imediatamente, execute `sudo systemctl start agileflow-web-update.service` no Debian.
4. Abra `https://debian.tail4baef6.ts.net/` ou o atalho `AgileFlow Online` e confira os projetos. GitHub Pages e Netlify redirecionam para o Debian.

O instalador salva cópias do workspace, da API e do atualizador anteriores em `/srv/agileflow/backups`. O atualizador preserva a versão anterior do WebApp em `/opt/agileflow/web.previous`.

## Dados

- Principal: `/srv/agileflow/workspace.json`
- Arquivos por projeto: `/srv/agileflow/projects/`
- Backups automáticos: `/srv/agileflow/backups/`
- O ZIP contém somente código. Não contém projetos, senhas ou chaves.

Dois aparelhos podem ler os mesmos projetos. Se ambos tentarem gravar versões diferentes, o servidor rejeita a segunda gravação e o WebApp oferece baixar a cópia da aba antes de escolher qual manter.
