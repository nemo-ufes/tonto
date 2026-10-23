# Installing tonto / Instalando o tonto

[English](#english) · [Português do Brasil](#português-do-brasil)

This guide is for people receiving tonto as a private VSIX file. tonto does
not need to be published in the Visual Studio Marketplace or npm registry.

Este guia destina-se a quem recebe o tonto como um arquivo VSIX privado. O
tonto não precisa estar publicado no Visual Studio Marketplace nem no registro
npm.

---

## English

### What you need

- Desktop [Visual Studio Code](https://code.visualstudio.com/) 1.95 or later.
- The file `tonto-VERSION.vsix` supplied by the tonto distributor.

That is the complete installation for editing models and for using tonto with
Codex, Claude Code, or agents that support VS Code's language-model tool API.
You do **not** need to install Node.js, npm, the tonto command line, or a
separate MCP server.

VS Code runs the extension with its own internal Node.js runtime. The VSIX
contains the tonto parser, validator, formatter, repair engine, and gUFO/OWL
mapping.

### 1. Install the extension

In VS Code:

1. Open the **Extensions** view.
2. Open the **Views and More Actions** (`...`) menu.
3. Select **Install from VSIX...**.
4. Select `tonto-VERSION.vsix`.
5. Confirm that you trust the person or organization that supplied it.
6. Reload VS Code if requested.

After installation, VS Code automatically opens **Get started with tonto**.
The walkthrough can create a valid one-file ontology, open the language guide,
show validation diagnostics, export the model, and introduce the agent tools.
To return to it later, run **Tonto: Get Started** from the Command Palette.

### Optional: install the standalone CLI

The CLI is a separate npm package; it is not needed by the VS Code extension.
The standalone CLI requires Node.js 22 or later. Install it globally for a
shell-wide command:

```sh
npm install --global tonto-language
tonto --version
tonto guide
```

For a project-pinned version, install it in the model project and run it with
`npx`:

```sh
npm install --save-dev tonto-language
npx tonto check model.tonto
```

See the [CLI package guide](../packages/language/README.md) for the one-time
`npx --package` form and upgrade instructions. The extension's agent setup
continues to use its bundled MCP server independently of this CLI install.

If the `code` command is available, the equivalent command is:

```sh
code --install-extension ./tonto-VERSION.vsix
```

A privately installed VSIX does not normally update itself. Install the newer
VSIX when the distributor provides one. When tonto next activates, it also
refreshes the bundled MCP runtime used by existing Codex and Claude project
configurations; start a new agent chat to load newly added tools or parameters.

### 2. Open a tonto project

A VS Code workspace is the folder in which tonto finds and checks `.tonto`
files. It may contain several ontologies; each `ontology` header identifies
one. No configuration file, package installation, or initialization command
is required. The optional `tonto.json` sets workspace import locations.

The quickest route is **Create an ontology** in the tonto walkthrough, or
**Tonto: New Ontology...** from the Command Palette (or a folder's context
menu in the Explorer). It asks for an ontology name and creates
`<name>.tonto`. When the folder has no agent setup yet, it also installs the
shared agent guidance and configures the bundled tonto MCP server for Codex
and Claude Code, preserving existing instructions and other MCP servers; the
`tonto.agents.setUpOnCreate` setting turns that off. Opening a folder that
has tonto files and no agent setup offers the same setup once.

The walkthrough also recommends keeping an ongoing modeling workspace in a
Git repository. Open VS Code's **Source Control** view to review an existing
repository or select **Initialize Repository** for a new one. Git is optional;
a local repository is enough, and it does not determine ontology membership.

To start manually:

1. Create or choose a folder for the model.
2. In VS Code, select **File > Open Folder...** and open that folder.
3. Create a file such as `people.tonto`.

For example:

```tonto
ontology people

kind Person
```

Opening a `.tonto` file activates the extension. The editor provides
validation in the Problems panel, completion, hover information, navigation,
formatting, and quick fixes. On a blank package-level line, run
**Tonto: Insert Modeling Pattern...** to search the validated catalog and
insert a complete pattern with linked names.

When a model outgrows one file, run **Tonto: New Package...**: it asks which
ontology and what name, and writes the package file together with its entry
in the ontology file, splitting a one-file ontology first. The refactoring
**Split "people" into an ontology file and package "core"** on the `ontology`
line does the split alone. The file, still
the ontology file, then lists the ontology's packages
(`ontology people bundles core from <core.tonto>`), each package file states
its ontology (`package core in people`), and `use core` lets one package refer
to another. Keep the files belonging to the model under the folder opened in
VS Code.

To generate gUFO-aligned OWL/Turtle, run **Tonto: Export to gUFO...** from the
Command Palette. It lists the workspace's ontologies, each that can be
exported already checked, so Enter exports them all; from the editor context
menu it exports the ontology of that file. Each ontology is written beside
its ontology file as `<name>.ttl`, such as `people.ttl` beside `people.tonto`.
An ontology whose header has no `@namespace` is asked for one, which is then
written above its `ontology` line, so later exports do not ask again.

An agent can perform the same export with `tonto_gufo`: give it the saved
file path and `write`, and each `.ttl` is replaced atomically beside its
ontology file. For an ontology without a `@namespace`, supply `namespaceIri`
as its exact namespace (the same value as `/// @namespace`, including the
final `#` or `/`).

### 3. Use the Codex or Claude Code extension

Codex and Claude Code do not consume tools registered through another
extension's generic VS Code language-model API. They do support local MCP
servers, so tonto bundles its own eighteen-tool MCP server in the VSIX and
configures it for both agents. Codex reads its server from
`.codex/config.toml`; Claude reads `.mcp.json`.

If you used **Create an ontology** or **New Ontology...**, setup is already done. For an existing
model folder:

1. Open the folder in VS Code.
2. Run **Tonto: Set Up Codex and Claude in Workspace** from the
   Command Palette.
3. Approve or trust the project MCP server when the agent asks.
4. Start a **new Codex or Claude chat** so it loads the instructions and tools.

The command creates or updates five project files:

- `AGENTS.md`: shared tonto modeling instructions for Codex and other agents;
- `CLAUDE.md`: imports `AGENTS.md` for Claude Code;
- `.mcp.json`: registers the bundled server with Claude Code;
- `.claude/settings.json`: a hook that validates every `.tonto` file Claude
  Code edits, right after the edit. Errors go back to Claude as the edit's
  outcome, for it to repair before going on; warnings are added as context; a
  clean file adds nothing. An instruction to validate can be forgotten in a long
  session, and a hook cannot; and
- `.codex/config.toml`: registers the same server with Codex, which has no
  such hook, so for Codex the instruction to validate is what remains.

Existing instruction text, MCP servers, hooks, and Codex settings are preserved.
The generated agent runtime configuration is machine-specific and is kept out
of this repository: `.mcp.json`, `.claude/`, and `.codex/` are ignored by Git.
Each developer should run the setup command on their own machine to generate
paths to their installed VS Code runtime and extension storage.

The generated MCP entries use local paths to this machine's VS Code runtime
and extension storage. Codex uses the session's working directory as the model
workspace, so moving a project on the same machine does not require changing
an absolute `cwd` in its config. Open Codex at the project root so the whole
model is available. Claude supplies `CLAUDE_PROJECT_DIR` directly to the MCP
server for the project directory. On another machine, Claude's entry can use
that machine's VS Code runtime by setting `TONTO_VSCODE_NODE` and
`TONTO_MCP_RUNTIME` in Claude's environment. Otherwise, run the setup command
there to refresh both entries.
Codex's generated executable and runtime paths still need this per-machine
refresh; its config has no documented expansion for them.

The MCP server exposes the guide, validation, rules, patterns, completion,
repairs, formatting, AST, digest, edit comparison, held cross-file drafts, and
gUFO export, including regeneration of `.ttl` files inside the workspace. It
runs with VS Code's internal Node.js runtime; no external Node.js, npm package,
CLI, or MCP installation is required.

### 4. Use another VS Code agent

An agent that supports VS Code extension tools can use tonto directly through
the installed VSIX. No terminal configuration is required. Ask it naturally,
for example:

```text
Read the tonto guide, review this model, fix the unambiguous problems,
format the result, and validate it again.
```

The extension exposes tools for:

- reading the language guide, validation rules, modeling patterns, and
  reference tables;
- validating a saved model or an unsaved draft;
- finding completions and explaining valid stereotype combinations;
- applying safe repairs or one explicitly selected repair;
- formatting, parsing, reviewing, and comparing model edits;
- previewing a model as gUFO-aligned Turtle or regenerating its `.ttl` files
  beside its ontology files (or in a workspace-relative output directory); and
- holding draft files that are not on disk yet, listing the workspace's
  ontologies, and retrieving imported ontologies.

They are the same eighteen tools the MCP server gives Codex and Claude Code,
with the same parameters and answers. Inside the editor, a call that names no
file is about the active tonto file, or else the open workspace, and files
with unsaved changes are refused rather than read stale.

The modeling tools return proposed source rather than silently rewriting
`.tonto` files. The gUFO export tool is the exception: only when the agent
supplies `write` (or `outDir`), it atomically replaces the generated `.ttl`
files beside their ontology files (or inside that workspace-relative
directory). Normal editor review and approval still applies
to source changes made by the agent.

For these agents, `AGENTS.md` may still be useful for project-specific
instructions such as naming conventions or files that must not be changed.

If tools are not offered to the agent, check that:

- the tonto extension is enabled in the current workspace;
- the agent supports VS Code language-model tools;
- the workspace is trusted; and
- VS Code is version 1.95 or later.

### External agents and automation

The VSIX tools are available only to agents running through VS Code's tool
system. A terminal agent, CI job, or other process outside VS Code cannot use
VS Code's internal runtime. Such use requires the separately distributed tonto
CLI or MCP package and Node.js 22 or later. This is an optional, advanced setup
and is not needed for ordinary VS Code use.

With the CLI installed, `tonto init` sets up a folder for a terminal agent:

```sh
tonto init my-ontology
```

It writes instructions for the CLI in `AGENTS.md`, which Codex and Claude Code
read; a `CLAUDE.md` that imports them; and a Claude Code hook in
`.claude/settings.json` that runs `npx --no -- tonto hook` to check each
`.tonto` file Claude edits. In a folder with no model yet it also writes a
one-file ontology named after the folder (`--ontology=<name>` names it,
`--no-ontology` skips it). It registers no MCP server. Existing files keep
their other content, and running it again changes nothing. If the folder was
already set up with **Tonto: Set Up Codex and Claude in Workspace**, its
instructions and hook are kept. `tonto new ontology <name>` and
`tonto new package <name> --in=<ontology>` add ontologies and packages
afterward.

### Troubleshooting

- **A `.tonto` file appears as plain text:** enable the tonto extension and
  select **tonto** as the file language in the status bar.
- **Imports do not resolve:** open the model folder, not just an individual
  file, and `use` package names rather than filenames.
- **The gUFO export asks for a namespace:** that ontology's header has no
  `@namespace`. For a published ontology, enter its absolute HTTP(S)
  namespace ending in `#`; a local RDF preview may use a slash namespace.
  The command writes the value into the header.
- **Codex or Claude reports that no `tonto_*` tools are available:** run
  **Tonto: Set Up Codex and Claude in Workspace**, approve the project MCP
  server, and start a new chat. In Claude, `/mcp` shows its connection status.
- **Another agent does not see the tools:** verify the four items at the end
  of section 4. Installing Node.js will not make the tools appear inside an
  agent that does not support VS Code extension tools.
- **A remote, WSL, or container workspace behaves differently:** install the
  VSIX where VS Code indicates that workspace extensions run.

---

## Português do Brasil

### O que é necessário

- [Visual Studio Code](https://code.visualstudio.com/) para desktop, versão
  1.95 ou posterior.
- O arquivo `tonto-VERSAO.vsix` fornecido pelo distribuidor do tonto.

Essa é a instalação completa para editar modelos e utilizar o tonto com o
Codex, o Claude Code ou agentes compatíveis com a API de ferramentas de
modelos de linguagem do VS Code. **Não** é necessário instalar Node.js, npm, a
linha de comando do tonto ou um servidor MCP separado.

O VS Code executa a extensão com sua própria versão interna do Node.js. O VSIX
contém o analisador sintático, o validador, o formatador, o mecanismo de
correções e o mapeamento para gUFO/OWL.

### 1. Instale a extensão

No VS Code:

1. Abra a visão **Extensões**.
2. Abra o menu **Exibições e Mais Ações** (`...`).
3. Selecione **Instalar a partir do VSIX...**.
4. Selecione `tonto-VERSAO.vsix`.
5. Confirme que você confia na pessoa ou organização que forneceu o arquivo.
6. Recarregue o VS Code, caso isso seja solicitado.

Depois da instalação, o VS Code abre automaticamente **Get started with
tonto**. O roteiro pode criar um modelo inicial válido, abrir o guia da
linguagem, mostrar os diagnósticos de validação, exportar o modelo e apresentar
as ferramentas para agentes. Para abri-lo novamente, execute **Tonto: Get
Started** pela Paleta de Comandos.

Se o comando `code` estiver disponível, o comando equivalente é:

```sh
code --install-extension ./tonto-VERSAO.vsix
```

Um VSIX instalado de forma privada normalmente não é atualizado
automaticamente. Instale o novo VSIX quando o distribuidor disponibilizá-lo.
Na próxima ativação do tonto, a extensão também atualiza o runtime MCP usado
pelas configurações existentes do Codex e do Claude; inicie uma nova conversa
com o agente para carregar novas ferramentas ou parâmetros.

### Opcional: instale a CLI independente

A CLI é um pacote npm separado e não é necessária para usar a extensão do VS
Code. É preciso ter Node.js 22 ou posterior. Para disponibilizar `tonto` no
terminal, instale-o globalmente:

```sh
npm install --global tonto-language
tonto --version
tonto guide
```

Para fixar uma versão por projeto, instale-a no projeto do modelo e execute-a
com `npx`:

```sh
npm install --save-dev tonto-language
npx tonto check modelo.tonto
```

O [guia do pacote da CLI](../packages/language/README.md) descreve a execução
única com `npx --package` e como atualizar. A configuração de agentes da
extensão continua usando o MCP incluído, independentemente da instalação da
CLI.

### 2. Abra um projeto tonto

O workspace do VS Code é a pasta em que o tonto encontra e verifica os
arquivos `.tonto`. Ela pode conter várias ontologias; cada cabeçalho
`ontology` identifica uma delas. Não é necessário criar um arquivo de
configuração, instalar pacotes ou executar um comando de inicialização. O
arquivo opcional `tonto.json` define os locais das importações no workspace.

O caminho mais rápido é **Create an ontology** no roteiro do tonto, ou
**Tonto: New Ontology...** na Paleta de Comandos (ou no menu de contexto de
uma pasta no Explorer). Ele solicita um nome de ontologia e cria
`<nome>.tonto`. Quando a pasta ainda não tem configuração de agentes, ele
também instala as orientações compartilhadas e configura o servidor MCP do
tonto incluído no VSIX para o Codex e o Claude Code, preservando as instruções
e os demais servidores MCP existentes; a configuração
`tonto.agents.setUpOnCreate` desativa isso. Abrir uma pasta que tem arquivos
tonto e nenhuma configuração de agentes oferece a mesma configuração uma vez.

O roteiro também recomenda manter um workspace de modelagem contínua em um
repositório Git. Abra a visualização **Source Control** do VS Code para
examinar um repositório existente ou selecione **Initialize Repository** para
criar um novo. Git é opcional; um repositório local é suficiente e não
determina quais arquivos pertencem a uma ontologia.

Para começar manualmente:

1. Crie ou escolha uma pasta para o modelo.
2. No VS Code, selecione **Arquivo > Abrir Pasta...** e abra essa pasta.
3. Crie um arquivo, por exemplo, `pessoas.tonto`.

Por exemplo:

```tonto
ontology pessoas

kind Pessoa
```

Abrir um arquivo `.tonto` ativa a extensão. O editor oferece validação no
painel Problemas, autocompletar, informações ao passar o mouse, navegação,
formatação e correções rápidas.

Quando o modelo não couber mais em um arquivo, execute **Tonto: New
Package...**: ele pergunta qual ontologia e qual nome, e grava o arquivo do
pacote junto com a sua entrada no arquivo da ontologia, dividindo antes uma
ontologia de um arquivo só. A refatoração **Split "pessoas" into an ontology
file and package "core"** na linha `ontology` faz apenas a divisão. O arquivo,
que continua sendo o arquivo da ontologia, passa a listar os pacotes da
ontologia (`ontology pessoas bundles core from <core.tonto>`), cada arquivo de
pacote declara a sua ontologia (`package core in pessoas`) e `use core` permite
que um pacote se refira a outro. Mantenha os arquivos do modelo sob a pasta
aberta no VS Code.

Para gerar OWL/Turtle alinhado à gUFO, execute **Tonto: Export to gUFO...** pela
Paleta de Comandos. Ele lista as ontologias do workspace, cada uma que pode
ser exportada já marcada, de modo que Enter exporta todas; pelo menu de
contexto do editor, ele exporta a ontologia daquele arquivo. Cada ontologia é
gravada ao lado do seu arquivo de ontologia como `<nome>.ttl`, por exemplo
`pessoas.ttl` ao lado de `pessoas.tonto`. Uma ontologia cujo cabeçalho não tem
`@namespace` tem a sua solicitada, que é então escrita acima da linha
`ontology`, de modo que as exportações seguintes não perguntam novamente.

Um agente pode realizar a mesma exportação com `tonto_gufo`: forneça o caminho
do arquivo salvo e `write`, e cada `.ttl` é gravado atomicamente ao lado do
seu arquivo de ontologia. Para uma ontologia sem `@namespace`, forneça
`namespaceIri` como a namespace exata (o mesmo valor de `/// @namespace`,
inclusive o `#` ou `/` final).

### 3. Utilize a extensão Codex ou Claude Code

O Codex e o Claude Code não consomem ferramentas registradas pela API genérica
de modelos de linguagem de outra extensão do VS Code. Ambos aceitam servidores
MCP locais; por isso, o tonto inclui no VSIX seu próprio servidor MCP com dezessete
ferramentas e o configura para os dois agentes. O Codex lê a configuração em
`.codex/config.toml`; o Claude lê `.mcp.json`.

Se você utilizou **Create an ontology** ou **New Ontology...**, a configuração já foi feita. Para
uma pasta de modelos existente:

1. Abra a pasta no VS Code.
2. Execute **Tonto: Set Up Codex and Claude in Workspace** pela
   Paleta de Comandos.
3. Aprove ou marque como confiável o servidor MCP do projeto quando o agente
   solicitar.
4. Inicie uma **nova conversa no Codex ou no Claude** para carregar as
   instruções e as ferramentas.

O comando cria ou atualiza cinco arquivos do projeto:

- `AGENTS.md`: instruções compartilhadas de modelagem para o Codex e outros
  agentes;
- `CLAUDE.md`: importa `AGENTS.md` para o Claude Code;
- `.mcp.json`: registra o servidor incluído no VSIX no Claude Code;
- `.claude/settings.json`: um hook que valida cada arquivo `.tonto` que o
  Claude Code edita, logo após a edição. Os erros voltam ao Claude como
  resultado da edição, para que ele os repare antes de continuar; os avisos
  são acrescentados como contexto; um arquivo limpo não acrescenta nada. Uma
  instrução para validar pode ser esquecida numa sessão longa, e um hook não; e
- `.codex/config.toml`: registra o mesmo servidor no Codex, que não tem um hook
  assim; para o Codex, a instrução para validar é o que resta.

O texto de instruções, os servidores MCP, os hooks e as configurações do Codex
já existentes são preservados. As entradas MCP geradas usam caminhos locais para
o runtime do VS Code e o armazenamento da extensão nesta máquina. O Codex usa
o diretório de trabalho da sessão como workspace do modelo; portanto, mover
o projeto na mesma máquina não exige alterar um `cwd` absoluto. Abra o Codex
na raiz do projeto para disponibilizar o modelo inteiro. O Claude fornece
`CLAUDE_PROJECT_DIR` diretamente ao servidor MCP como diretório do projeto.
Em outra máquina, a entrada do Claude pode usar o runtime local do VS Code se
`TONTO_VSCODE_NODE` e `TONTO_MCP_RUNTIME` estiverem definidos no ambiente do
Claude. Caso contrário, execute o comando de configuração nessa máquina para atualizar as
duas entradas. Os caminhos do executável e do runtime gerados para o Codex
ainda exigem essa atualização local; sua configuração não tem expansão
documentada para eles.

O servidor MCP oferece o guia, validação, regras, padrões, autocompletar,
correções, formatação, AST, resumo estrutural, comparação de edições,
rascunhos mantidos entre arquivos e exportação gUFO, inclusive a regeneração
dos arquivos `.ttl` dentro do workspace. Ele utiliza o Node.js interno do VS
Code; não é necessário instalar Node.js, pacote npm, CLI ou servidor MCP
separadamente.

### 4. Utilize outro agente do VS Code

Um agente compatível com ferramentas de extensões do VS Code pode utilizar o
tonto diretamente por meio do VSIX instalado. Não é necessário configurar o
terminal. Faça uma solicitação em linguagem natural, por exemplo:

```text
Leia o guia do tonto, revise este modelo, corrija os problemas não ambíguos,
formate o resultado e valide-o novamente.
```

A extensão oferece ferramentas para:

- ler o guia da linguagem, as regras de validação, os padrões de modelagem e
  as tabelas de referência;
- validar um modelo salvo ou um rascunho ainda não salvo;
- obter sugestões de autocompletar e explicar combinações válidas de
  estereótipos;
- aplicar correções seguras ou uma correção específica escolhida
  explicitamente;
- formatar, analisar, revisar e comparar alterações em modelos;
- visualizar um modelo como Turtle alinhado à gUFO ou regenerar seus arquivos
  `.ttl` ao lado dos arquivos das respectivas ontologias (ou em um diretório
  de saída relativo ao workspace); e
- manter rascunhos que ainda não estão em disco, listar as ontologias do
  workspace e recuperar ontologias importadas.

As ferramentas de modelagem retornam o código-fonte proposto, sem reescrever
silenciosamente os arquivos `.tonto`. A ferramenta de exportação gUFO é a
exceção: somente quando o agente fornece `write` (ou `outDir`), ela substitui
atomicamente os arquivos `.ttl` gerados ao lado dos seus arquivos de ontologia
(ou dentro desse diretório relativo ao workspace). A revisão
e a aprovação normais do editor continuam valendo para alterações no código-
fonte feitas pelo agente.

Para esses agentes, `AGENTS.md` ainda pode ser útil para instruções específicas
do projeto, como convenções de nomes ou arquivos que não devem ser alterados.

Caso as ferramentas não sejam oferecidas ao agente, verifique se:

- a extensão tonto está habilitada no workspace atual;
- o agente é compatível com ferramentas de modelos de linguagem do VS Code;
- o workspace é confiável; e
- a versão do VS Code é 1.95 ou posterior.

### Agentes externos e automação

As ferramentas do VSIX estão disponíveis apenas para agentes que utilizam o
sistema de ferramentas do VS Code. Um agente de terminal, uma tarefa de
integração contínua ou outro processo externo não pode utilizar a versão
interna do Node.js do VS Code. Esses casos exigem o pacote separado da linha de
comando ou do servidor MCP do tonto e Node.js 22 ou posterior. Essa é uma
configuração opcional e avançada, desnecessária para o uso normal no VS Code.

Com a linha de comando instalada, `tonto init` prepara uma pasta para um
agente de terminal:

```sh
tonto init minha-ontologia
```

O comando escreve instruções para a linha de comando em `AGENTS.md`, lidas pelo
Codex e pelo Claude Code; um `CLAUDE.md` que as importa; e um hook do Claude
Code em `.claude/settings.json` que executa `npx --no -- tonto hook` para
verificar cada arquivo `.tonto` editado pelo Claude. Em uma pasta ainda sem
modelo, escreve também uma ontologia de arquivo único com o nome da pasta
(`--ontology=<nome>` define o nome; `--no-ontology` a omite). Nenhum servidor
MCP é registrado. Arquivos existentes mantêm o restante de seu conteúdo, e
executar o comando novamente não altera nada. Se a pasta já foi configurada
com **Tonto: Set Up Codex and Claude in Workspace**, suas instruções e seu
hook são mantidos. `tonto new ontology <nome>` e
`tonto new package <nome> --in=<ontologia>` acrescentam ontologias e pacotes
depois.

### Solução de problemas

- **Um arquivo `.tonto` aparece como texto simples:** habilite a extensão
  tonto e selecione **tonto** como a linguagem do arquivo na barra de status.
- **As importações não são resolvidas:** abra a pasta do modelo, não apenas um
  arquivo individual, e use (`use`) nomes de pacotes em vez de nomes de arquivos.
- **O comando de exportação solicita uma namespace:** o cabeçalho daquela
  ontologia não tem `@namespace`. Para uma ontologia publicada, informe a
  namespace HTTP(S) absoluta terminada em `#`; uma visualização RDF local
  pode usar uma namespace terminada em `/`. O comando grava o valor no
  cabeçalho.
- **O Codex ou o Claude informa que nenhuma ferramenta `tonto_*` está
  disponível:** execute **Tonto: Set Up Codex and Claude in Workspace**, aprove
  o servidor MCP do projeto e inicie uma nova conversa. No Claude, `/mcp`
  mostra o estado da conexão.
- **Outro agente não encontra as ferramentas:** verifique os quatro itens ao
  final da seção 4. Instalar o Node.js não disponibiliza as ferramentas em um
  agente que não seja compatível com ferramentas de extensões do VS Code.
- **Um workspace remoto, WSL ou de contêiner funciona de modo diferente:**
  instale o VSIX onde o VS Code indicar que as extensões do workspace são
  executadas.
