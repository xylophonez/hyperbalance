export type TemplateValue = string | number | bigint | boolean | undefined

export function applyTemplate(
  template: string,
  values: Record<string, TemplateValue>,
): string {
  return template.replaceAll(/\{([A-Za-z0-9_-]+)\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) {
      throw new Error(`Missing template value: ${key}`)
    }

    return encodeURIComponent(String(value))
  })
}

export function applyTemplateMap(
  templates: Record<string, string> | undefined,
  values: Record<string, TemplateValue>,
): Record<string, string> {
  if (!templates) return {}

  return Object.fromEntries(
    Object.entries(templates).map(([key, template]) => [key, applyTemplate(template, values)]),
  )
}

