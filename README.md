# Bot de Ponto Discord — Multi-servidor

Esta versão mantém o funcionamento da versão anterior e adiciona suporte a vários servidores usando o MESMO bot e o MESMO processo Node.js.

## O que muda

Cada servidor agora possui configuração própria no SQLite:

- canal do painel / bate-ponto;
- canal administrativo de dados;
- cargo ADM extra;
- calls autorizadas;
- call AFK;
- tolerância ao sair da call;
- tempo do aviso público.

Os registros de ponto já eram separados por `guild_id`, então históricos e horas de um servidor não se misturam com outro.

## Compatibilidade com o servidor antigo

O `.env` antigo continua aceito como migração da instalação já existente.
Os valores de `GUILD_ID`, `ADMIN_ROLE_ID`, `ALLOWED_VOICE_CHANNEL_IDS`,
`AFK_CHANNEL_ID`, `VOICE_GRACE_SECONDS`, `PUBLIC_CLOSE_SECONDS` e
`PONTO_CHANNEL_ID` são importados somente para o servidor indicado em
`GUILD_ID`.

Depois disso, cada servidor usa as configurações salvas no banco.

## Configurando um novo servidor

Convide o mesmo bot para o novo servidor com os escopos:

- `bot`
- `applications.commands`

Permissões recomendadas:

- Ver canais
- Enviar mensagens
- Ler histórico de mensagens
- Incorporar links
- Ver registro de auditoria

Depois inicie o bot normalmente:

```powershell
npm start
```

Ao entrar em um novo servidor, os comandos slash são registrados automaticamente.

### 1. Ver configuração

```text
/config-ponto status
```

### 2. Adicionar calls autorizadas

Execute uma vez para cada call de trabalho:

```text
/config-ponto adicionar-call canal:#Lobby
```

Enquanto não houver nenhuma call autorizada, o ponto automático não inicia.

### 3. Definir call AFK

```text
/config-ponto afk canal:#AFK
```

A call AFK é removida automaticamente da lista de calls autorizadas se estiver nela.

### 4. Definir cargo ADM extra

Usuários que possuem a permissão Administrador do Discord sempre têm acesso.
Opcionalmente, configure outro cargo:

```text
/config-ponto cargo-admin cargo:@Admin
```

### 5. Configurar tolerância

Exemplo para 60 segundos:

```text
/config-ponto tolerancia segundos:60
```

### 6. Configurar duração dos avisos

Exemplo para 40 segundos:

```text
/config-ponto aviso-publico segundos:40
```

### 7. Criar o painel de ponto

Entre no canal onde o painel deve ficar e use:

```text
/painel-ponto
```

Esse canal passa a receber também os avisos públicos de início e fechamento.

### 8. Configurar o canal administrativo

Entre no canal de acompanhamento e use:

```text
/config-dados
```

Depois use `/dados` normalmente.

## Outros comandos de configuração

```text
/config-ponto remover-call
/config-ponto limpar-calls
/config-ponto limpar-afk
/config-ponto limpar-cargo-admin
/config-ponto status
```

## Funcionamento do ponto

- Entrou em call autorizada: ponto inicia automaticamente.
- Entrou em outra call autorizada: o mesmo ponto continua.
- Saiu completamente: inicia a tolerância configurada para aquele servidor.
- Voltou dentro da tolerância: ponto continua.
- Não voltou: ponto fecha usando o horário em que saiu da call.
- Entrou em call AFK: fecha imediatamente.
- Entrou em call não autorizada: fecha imediatamente.
- Histórico: semanal, de segunda a domingo.

## Banco existente

O ZIP não inclui `ponto.db`.

Para preservar o histórico atual, atualize os arquivos do bot dentro da pasta em que já existe o seu `ponto.db`. Na primeira execução, o banco antigo recebe automaticamente as novas colunas de configuração multi-servidor.


## Avisos temporários
- O aviso público de **Ponto iniciado** é apagado automaticamente após 30 segundos.
- O ponto continua aberto normalmente no banco mesmo depois que o aviso some.
- Os avisos de fechamento continuam usando o tempo configurado em `/config-ponto aviso-publico`.
