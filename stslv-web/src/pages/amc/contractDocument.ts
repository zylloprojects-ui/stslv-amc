// The contract document a new AMC contract must carry (Add AMC Contract, 2026-11-03).
// These checks mirror the API's so most problems are shown before anything is sent;
// the API checks again, including the file's content, and remains the authority.

/** The file name extensions accepted, with the types a browser may report for each. */
const TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
}

/** For the file picker. */
export const CONTRACT_DOCUMENT_ACCEPT = `.pdf,.doc,.docx,${Object.values(TYPES).flat().join(',')}`

/** Used until the server's own limit has been read (GET /attachments/limits); the API's default. */
export const DEFAULT_MAX_MB = 12

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Why a chosen file cannot be the contract document, or null when it can. */
export function contractDocumentProblem(file: Pick<File, 'name' | 'size' | 'type'>, maxMb: number): string | null {
  const extension = file.name.includes('.') ? (file.name.split('.').pop() ?? '').toLowerCase() : ''
  const types = TYPES[extension]

  // Some systems report no type for a Word file; the name and, on the server, the content still decide.
  if (!types || (file.type !== '' && !types.includes(file.type))) {
    return 'Choose a PDF or Word document (.pdf, .doc or .docx).'
  }
  if (file.size === 0) {
    return 'The chosen file is empty. Choose another file.'
  }
  if (file.size > maxMb * 1024 * 1024) {
    return `The file is ${formatFileSize(file.size)}. Contract documents can be at most ${maxMb} MB.`
  }

  return null
}

/** The file's content as base64, as POST /amc/contracts expects it. */
export function readAsBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : ''
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(new Error('The contract document could not be read. Choose the file again.'))
    reader.readAsDataURL(file)
  })
}
