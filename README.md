# NIT — Not Git

O NIT é um sistema de controle de versões educacional, escrito em Node.js, para explorar as ideias fundamentais do Git. Ele armazena conteúdo por hash, prepara snapshots, registra commits e permite navegar entre versões, criar branches e fazer merges simples.

> **Projeto de estudo:** o NIT não é compatível com repositórios Git e não substitui uma ferramenta de produção. Não o use para guardar a única cópia de arquivos importantes.

## O que o NIT faz

| Comando                          | O que faz                                                   |
| -------------------------------- | ----------------------------------------------------------- |
| `nit init`                       | Inicializa um repositório no diretório atual.               |
| `nit add <arquivo>`              | Prepara um arquivo individual ou sua remoção.               |
| `nit commit -m "mensagem"`       | Registra o snapshot preparado em um commit.                 |
| `nit log`                        | Mostra o histórico, seguindo o primeiro pai de cada commit. |
| `nit branch <nome>`              | Cria uma branch no commit atual.                            |
| `nit checkout <hash-ou-branch>`  | Restaura um commit ou troca de branch.                      |
| `nit merge <branch>`             | Integra uma branch à branch atual.                          |
| `nit hash-object [-w] <arquivo>` | Calcula o hash de um blob; `-w` também o armazena.          |
| `nit cat-file <hash>`            | Mostra tipo, tamanho e conteúdo de um objeto.               |

Os hashes informados a `checkout` e `cat-file` devem ser completos: 40 caracteres hexadecimais minúsculos. Use `nit --help` para consultar os comandos.

## Instalação e configuração

É necessário ter **Node.js 20 ou superior** e npm. Na raiz deste projeto:

```sh
npm install
```

Configure sua identidade no arquivo `.env` ao lado de `main.js`. Se necessário, crie-o a partir do exemplo:

```sh
cp .env.example .env
```

Edite `.env` e informe seu nome:

```dotenv
NIT_AUTHOR="Seu Nome <seu@email.com>"
```

O autor é obrigatório para commits e merges que criam commit. O NIT lê esse `.env` independentemente do diretório em que você executa o comando. Se `NIT_AUTHOR` já estiver definido no ambiente, ele tem prioridade (inclusive se estiver vazio).

Para disponibilizar o comando `nit` no ambiente local do npm:

```sh
npm link
nit --help
```

Sem `npm link`, execute `node /caminho/para/nit/main.js <comando>`. Por exemplo, a partir de `sandbox/`, use `node ../main.js log`.

## Usando em um projeto

Em um diretório que deseja versionar:

```sh
nit init
nit add arquivo.txt
nit commit -m "Adiciona arquivo"
nit log
```

`add` salva os bytes atuais como um blob e prepara seu caminho no index. Alterações posteriores no arquivo não entram no commit até que ele seja adicionado novamente. Se um arquivo rastreado for removido, execute `nit add <caminho-removido>` para preparar a remoção antes de commitar.

Para caminhos que começam com `-`, use `--` antes do nome, por exemplo `nit add -- -arquivo.txt`. As opções `-m` e `-w` também podem ser escritas como `--message` e `--write`.

## Explorando o sandbox

O diretório `sandbox/` pode ser usado para observar versões alternativas de um exemplo: uma branch `main` com Hello World em C e uma branch `rust` com o equivalente em Rust. Os comandos abaixo pressupõem que esse repositório NIT e essas branches já tenham sido criados; o conteúdo visível depende do estado atual do seu sandbox.

Entre no diretório e consulte o histórico da posição atual:

```sh
cd sandbox
nit log
```

Troque para `main` e observe os arquivos daquela versão:

```sh
nit checkout main
ls
```

Depois, troque para `rust` e compare:

```sh
nit checkout rust
ls
```

O checkout atualiza os arquivos rastreados e o index conforme o snapshot da branch. Ele não move a outra branch. O NIT recusa a troca se houver alterações preparadas ou não preparadas em arquivos rastreados, ou se algum arquivo não rastreado obstruir a operação.

Para navegar até um commit específico, copie o hash completo mostrado pelo `nit log`:

```sh
nit checkout <hash-completo-do-commit>
nit log
```

Nesse estado, o `HEAD` fica **destacado**: ele aponta diretamente para o commit, não para uma branch. Um novo commit nesse estado não move `main` nem `rust`. Para voltar à versão mais recente de uma branch:

```sh
nit checkout main
# ou
nit checkout rust
```

Se o checkout reclamar de um arquivo removido, a remoção pode ainda não estar preparada. Para preservá-la no histórico da branch atual, use `nit add <caminho-removido>` e depois `nit commit -m "mensagem"` antes de trocar de branch. O NIT não oferece `status`, `stash` ou checkout forçado nesta versão.

### Criar e integrar outra branch

Depois de pelo menos um commit, você pode criar uma branch sem sair da atual:

```sh
nit branch experimento
nit checkout experimento
```

Após editar, adicionar e commitar os arquivos desejados, volte à branch que receberá as mudanças e faça o merge:

```sh
nit checkout main
nit merge experimento
```

O merge exige uma branch atual com commit e o index e os arquivos rastreados limpos. Ele faz **fast-forward** quando possível; para históricos divergentes, compara os snapshots por caminho e cria um commit com dois pais se não houver conflito. Conflitos abortam a operação e listam os caminhos; não há resolução interativa nem merge por linha.

## Como funciona por dentro

```text
HEAD → branch → commit → tree raiz → blob (conteúdo de arquivo)
                   │          └────→ tree de subdiretório → blob
                   └→ commit pai → ...
```

- **Working tree:** os arquivos que você edita.
- **Index:** o mapa de caminhos e blobs preparado para o próximo commit.
- **Blob:** os bytes de um arquivo, sem nome nem caminho.
- **Tree:** associa nomes a blobs e outras trees, representando um diretório.
- **Commit:** aponta para uma tree raiz e registra pais, autor, data e mensagem.
- **Branch:** referência mutável para um commit; `HEAD` indica a posição atual.

Os metadados ficam em `.nit/`. A object store calcula SHA-1 sobre a representação `tipo tamanho\0conteúdo` e guarda objetos soltos comprimidos com zlib em `.nit/objects/`. O index, as trees e os commits usam formatos próprios do NIT; em particular, trees e commits não têm os mesmos hashes que seus equivalentes Git.

Para inspecionar um blob:

```sh
nit hash-object -w arquivo.txt
nit cat-file <hash-completo-do-blob>
```

`cat-file` escreve um cabeçalho com tipo e tamanho, seguido dos bytes originais. Conteúdo binário pode não ser legível no terminal.

## Limitações

- Não há packfiles, compressão delta, remotos, `status`, `diff`, `stash` ou regras de ignore.
- `add` aceita um arquivo comum por vez; diretórios, links simbólicos e modos de arquivo especiais não são versionados.
- Checkout e merge tentam recuperar alterações se uma escrita falhar, mas não são transações duráveis: interrupções, falhas de recuperação ou operações simultâneas podem exigir intervenção manual.
- O NIT não bloqueia operações simultâneas no mesmo repositório. Use cópias descartáveis para experimentar.
- `.env` é ignorado pelo Git deste projeto, mas não pelo NIT. Evite adicioná-lo a um repositório NIT se contiver informações privadas.

## Referências

- [Pro Git — Git Internals](https://git-scm.com/book/en/v2/Git-Internals-Plumbing-and-Porcelain)
- [Documentação do Git](https://git-scm.com/docs)
- [Documentação do Node.js](https://nodejs.org/docs/latest/api/)
