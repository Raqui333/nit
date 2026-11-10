/**
 * CONTEXTO: OBJECT STORE
 *
 * A object store guarda objetos imutáveis identificados por um hash calculado
 * a partir de seu tipo e conteúdo. Por exemplo, dois arquivos com os mesmos
 * bytes produzem o mesmo blob, mesmo que tenham nomes ou caminhos diferentes.
 * O nome e o caminho não ficam no blob: serão associados a ele pelas trees.
 *
 * Usamos Buffer em vez de apenas strings porque arquivos são sequências de
 * bytes e podem conter dados binários, bytes NUL ou texto em UTF-8. Uma string
 * pode exigir uma conversão que altere bytes, e sua quantidade de caracteres
 * não corresponde necessariamente ao tamanho em bytes: "á" ocupa dois bytes
 * em UTF-8. O tamanho no cabeçalho e o hash precisam considerar os bytes exatos.
 *
 * Cada objeto é serializado como "<tipo> <tamanho>\0<conteúdo>". Calculamos
 * o SHA-1 dessa representação antes de comprimi-la com zlib; o hash determina
 * o endereço em .nit/objects/. A compressão reduz o espaço usado, mas não muda
 * a identidade do objeto e não deve ser confundida com compressão delta.
 *
 * SHA-1 é uma escolha didática para estudar o formato clássico do Git, não uma
 * garantia moderna contra colisões. A store aceita tipos blob, tree e commit,
 * com trees e commits em formatos próprios do NIT.
 */

import {
  linkSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'

// A object store aceita estes tipos, mas somente blobs são criados pela CLI
// diretamente por hash-object. Trees e commits são construídos internamente.
const objectTypes = new Set(['blob', 'tree', 'commit'])
// Um SHA-1 completo tem 160 bits, representados por 40 dígitos hexadecimais.
const hashPattern = /^[0-9a-f]{40}$/

/**
 * Monta a representação canônica: "<tipo> <tamanho>\0<conteúdo>".
 *
 * O tamanho é medido em bytes, não em caracteres: em UTF-8, por exemplo,
 * "á" ocupa dois bytes. O byte NUL (\0) separa o cabeçalho do conteúdo;
 * outros bytes NUL podem existir normalmente dentro do próprio conteúdo.
 * O resultado é um Buffer para preservar também arquivos binários.
 */
export function serializeObject(type, content) {
  // 1. Garante que o tipo é conhecido e que o conteúdo preserva bytes brutos.
  if (!objectTypes.has(type)) throw new Error(`Invalid object type: ${type}`)

  if (!Buffer.isBuffer(content))
    throw new TypeError('Object content must be a Buffer.')

  // 2. Cria o cabeçalho ASCII com o tamanho em bytes e o separador NUL.
  const header = Buffer.from(`${type} ${content.length}\0`, 'ascii')

  // 3. Acrescenta o conteúdo sem convertê-lo para texto.
  return Buffer.concat([header, content])
}

/**
 * Calcula o SHA-1 dos bytes serializados, incluindo tipo e tamanho.
 * O hash identifica o objeto antes da compressão e é exibido em hexadecimal.
 * SHA-1 é usado aqui para estudar o formato clássico do Git; não deve ser
 * tratado como uma garantia moderna de segurança contra colisões.
 */
export function hashObject(serialized) {
  // Inicializa o SHA-1, alimenta-o com os bytes e devolve o digest hexadecimal.
  return createHash('sha1').update(serialized).digest('hex')
}

/** Comprime um objeto solto com zlib; isso não é compressão delta. */
export function compressObject(serialized) {
  // A compressão é aplicada depois do cálculo do hash, sobre o objeto inteiro.
  return deflateSync(serialized)
}

/**
 * Converte um hash completo em .nit/objects/<2 primeiros>/<38 restantes>.
 * Validar o formato também impede que o hash seja usado como caminho arbitrário.
 */
function objectPath(root, hash) {
  // 1. Exige um identificador completo antes de utilizá-lo como caminho.
  if (!hashPattern.test(hash))
    throw new Error(
      'Invalid object hash: expected 40 lowercase hexadecimal characters.',
    )

  // 2. Distribui os objetos por diretórios usando os dois primeiros dígitos.
  return join(root, '.nit', 'objects', hash.slice(0, 2), hash.slice(2))
}

/**
 * Confere os bytes descomprimidos antes de devolvê-los ao chamador:
 * 1. recalcula o hash e o compara com o endereço solicitado;
 * 2. encontra o primeiro byte NUL e valida o tipo e o tamanho no cabeçalho;
 * 3. compara o tamanho declarado com a quantidade real de bytes do conteúdo.
 *
 * Retorna tipo, tamanho e conteúdo; este último continua sendo um Buffer.
 */
export function validateObject(serialized, expectedHash) {
  // 1. Confere se os bytes lidos realmente correspondem ao endereço solicitado.
  if (hashObject(serialized) !== expectedHash)
    throw new Error(`Object hash mismatch: ${expectedHash}`)

  // 2. Separa o cabeçalho do conteúdo no primeiro byte NUL.
  const separator = serialized.indexOf(0)

  if (separator === -1)
    throw new Error('Invalid object: missing header separator.')

  // 3. Exige um cabeçalho ASCII com tipo permitido e tamanho decimal canônico.
  const headerBytes = serialized.subarray(0, separator)
  const header = headerBytes.toString('ascii')

  if (!Buffer.from(header, 'ascii').equals(headerBytes))
    throw new Error('Invalid object header.')

  const match = /^(blob|tree|commit) (0|[1-9][0-9]*)$/.exec(header)

  if (!match) throw new Error('Invalid object header.')

  // 4. Compara o tamanho declarado com os bytes restantes, sem convertê-los.
  const content = serialized.subarray(separator + 1)

  if (String(content.length) !== match[2])
    throw new Error('Invalid object size.')

  // 5. Devolve os metadados e o conteúdo validado para o chamador.
  return { type: match[1], size: content.length, content }
}

/**
 * Lê um objeto pelo hash: resolve seu caminho, lê e descomprime os bytes e,
 * por fim, valida sua integridade. Um objeto ausente ou corrompido gera erro.
 */
export function readObject(root, hash) {
  // 1. Resolve o endereço e lê o objeto comprimido da object store.
  const path = objectPath(root, hash)
  let compressed

  try {
    compressed = readFileSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`Object not found: ${hash}`)

    throw error
  }

  // 2. Descomprime os bytes; dados que não forem zlib válido geram erro.
  let serialized

  try {
    serialized = inflateSync(compressed)
  } catch (error) {
    throw new Error(`Corrupt object: ${hash}`, { cause: error })
  }

  // 3. Só entrega o objeto depois de validar hash, cabeçalho e tamanho.
  return validateObject(serialized, hash)
}

/**
 * Persiste um objeto e retorna seu hash:
 * 1. serializa tipo e conteúdo e calcula o identificador;
 * 2. comprime a representação e grava um arquivo temporário;
 * 3. publica o objeto no caminho derivado do hash sem substituir outro;
 * 4. remove o nome temporário, inclusive quando ocorre um erro.
 *
 * Se o destino já existir, lemos e validamos seu conteúdo antes de reutilizá-lo.
 */
export function writeObject(root, type, content) {
  // 1. Serializa e calcula o hash antes de comprimir: ele define o endereço.
  const serialized = serializeObject(type, content)
  const hash = hashObject(serialized)
  const path = objectPath(root, hash)
  const directory = join(root, '.nit', 'objects', hash.slice(0, 2))

  // 2. Prepara o diretório correspondente aos dois primeiros dígitos do hash.
  mkdirSync(directory, { recursive: true })

  // O hard link publica somente depois da escrita completa e falha se o destino
  // já existir. Isso depende do suporte do sistema de arquivos a hard links e
  // não garante, por si só, durabilidade em uma queda de energia.
  // 3. Reserva um nome temporário aleatório no mesmo diretório do destino.
  const temporary = join(directory, `tmp-${randomBytes(16).toString('hex')}`)
  let created = false

  try {
    // 4. Comprime e grava exclusivamente no temporário antes da publicação.
    writeFileSync(temporary, compressObject(serialized), { flag: 'wx' })
    created = true
    try {
      // 5. Publica sem substituir um objeto que já esteja no endereço final.
      linkSync(temporary, path)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error

      // 6. Se já existir, valida o objeto e só o reutiliza se for igual.
      const existing = readObject(root, hash)

      if (existing.type !== type || !existing.content.equals(content))
        throw new Error(
          `Existing object differs from requested content: ${hash}`,
        )
    }
  } finally {
    // Remover o nome temporário não remove o hard link publicado no destino.
    if (created) unlinkSync(temporary)
  }

  return hash
}
