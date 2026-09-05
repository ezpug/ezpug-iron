#!/usr/bin/env node
// The C# generator (PRD-02 T1, decision 2: "its C# types are generated from
// the Zod schemas so the two languages cannot drift"). Reads the server link's
// JSON Schema (`packages/protocol/schema/server-link.schema.json`, itself
// written from Zod by `protocol-schema.mjs`) and writes
// `plugins/EZPug.Sdk/Generated/ServerLink.g.cs`: one record per object, one
// enum per string set, one abstract record plus a converter per discriminated
// union, the constants, and the `JsonSerializerOptions` that make it all read
// and write the bytes the TypeScript side writes.
//
// Why not NJsonSchema or quicktype (the PRD's two candidates, both tried on
// this schema on 2026-09-05): neither represents a `oneOf` of objects with a
// `const` discriminator as a typed union — NJsonSchema keeps the first branch
// and drops the rest, quicktype merges every branch into one class of
// optionals with invented names — and neither tells an absent optional from an
// explicit null, so neither could round-trip the recorded fixtures byte for
// byte. This is ~400 lines that do exactly the subset Zod emits, and refuse
// anything outside it loudly.
//
// The rules, so a reader can predict the C#:
//   - a `$defs` entry is a type of that name; a nested anonymous object is
//     named `<Owner><Property>` (array items singularized);
//   - `oneOf` with `x-branch` → `abstract record <Name>` and one sealed
//     record per branch named `<PascalConst><x-branch>` (the suffix is not
//     doubled: `plugin_event` + `Event` is `PluginEvent`), with a `const string
//     TypeName` and a get-only `Type`; a converter dispatches on the
//     discriminator wherever the JSON puts it, and writes the runtime type;
//   - a required property → `required T`; a required nullable → `T?`;
//     an optional → `T?` with `[JsonIgnore(WhenWritingNull)]`; a property with
//     a default → an initializer; a `const` → a get-only property. Optional
//     *and* nullable is refused (absent and null would collapse);
//   - `integer` → long, `number` → double (written the way JavaScript prints
//     one, so `0.000001` stays `0.000001`), `string` enums → C# enums with
//     `[JsonStringEnumMemberName]`, `record<string, string>` → Dictionary,
//     `record<string, unknown>` → JsonObject, unknown → JsonNode;
//   - every property carries `[JsonPropertyOrder]` in schema order, so the
//     bytes come out in the order Zod's parse emits them.
//
// `--check` regenerates in memory and fails when the committed file differs
// (part of `pnpm lint`); `pnpm build` writes it.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = 'packages/protocol/schema/server-link.schema.json'
const OUTPUT = 'plugins/EZPug.Sdk/Generated/ServerLink.g.cs'
const NAMESPACE = 'EZPug.Sdk.Protocol'

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const pascal = text =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map(part => part[0].toUpperCase() + part.slice(1))
    .join('')

const enumMember = value => {
  const name = pascal(value)
  return /^[0-9]/.test(name) ? `_${name}` : name
}

/** `events` → `Event`, `entries` → `Entry`, `sides` stays `Sides` only where it is not an array. */
const singular = name => {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`
  if (name.endsWith('ses')) return name.slice(0, -2)
  if (name.endsWith('s') && !name.endsWith('ss')) return name.slice(0, -1)
  return name
}

const csString = text =>
  `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`

const xml = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

class Generator {
  constructor(document) {
    this.document = document
    this.defs = document.$defs
    /** name → { kind, text } in emission order. */
    this.types = new Map()
    /** Union names, for the converters. */
    this.unions = []
    for (const [name, def] of Object.entries(this.defs)) this.emitDef(name, def)
  }

  fail(where, message) {
    throw new Error(`protocol-codegen: ${where}: ${message}`)
  }

  refName(node) {
    const match = /^#\/\$defs\/([A-Za-z0-9]+)$/.exec(node.$ref ?? '')
    if (!match || !(match[1] in this.defs)) this.fail(node.$ref, 'unknown $ref')
    return match[1]
  }

  /** What a `$defs` entry is, without emitting it. */
  defKind(name) {
    const def = this.defs[name]
    if (def.oneOf) return 'union'
    if (def.enum) return 'enum'
    if (def.anyOf) return this.isStringSet(def.anyOf) ? 'enum' : 'nullable'
    if (def.type === 'object' && def.properties) return 'record'
    if (def.type === 'object') return 'dictionary'
    if (['string', 'integer', 'number', 'boolean'].includes(def.type)) return 'primitive'
    this.fail(name, `cannot classify ${JSON.stringify(def).slice(0, 80)}`)
  }

  isStringSet(options) {
    return options.every(option => {
      if (option.$ref) return this.defKind(this.refName(option)) === 'enum'
      return (
        (option.type === 'string' && (option.enum || typeof option.const === 'string')) ?? false
      )
    })
  }

  stringSetValues(options) {
    return options.flatMap(option => {
      if (option.$ref) return this.stringSetValues([this.defs[this.refName(option)]])
      if (option.enum) return option.enum
      if (option.anyOf) return this.stringSetValues(option.anyOf)
      return [option.const]
    })
  }

  emitDef(name, def) {
    const kind = this.defKind(name)
    if (kind === 'union') this.emitUnion(name, def)
    else if (kind === 'enum')
      this.emitEnum(name, def.enum ?? this.stringSetValues(def.anyOf), xml(def.description))
    else if (kind === 'record') this.emitRecord(name, def, { description: xml(def.description) })
    else if (kind === 'primitive' || kind === 'dictionary') {
      // A named string with a pattern, a named map: used inline, no C# type of its own.
    } else this.fail(name, `a top-level ${kind} has no C# twin`)
  }

  emitEnum(name, values, description) {
    if (this.types.has(name)) return
    const members = values.map(
      value => `    [JsonStringEnumMemberName(${csString(value)})]\n    ${enumMember(value)},`,
    )
    this.types.set(name, {
      kind: 'enum',
      text: `${doc(description)}public enum ${name}\n{\n${members.join('\n')}\n}\n`,
    })
  }

  emitUnion(name, def) {
    const suffix = def['x-branch']
    if (!suffix) this.fail(name, 'a union needs an `x-branch` suffix for its branches')
    const options = def.oneOf
    const discriminators = options.map(option =>
      Object.keys(option.properties ?? {}).filter(
        key => typeof option.properties[key].const === 'string',
      ),
    )
    const shared = discriminators.reduce((acc, keys) => acc.filter(key => keys.includes(key)))
    if (shared.length !== 1)
      this.fail(
        name,
        `expected exactly one string const shared by every branch, found ${shared.join(', ') || 'none'}`,
      )
    const discriminator = shared[0]
    // Reserve the base's slot so it precedes its branches in the file.
    this.types.set(name, { kind: 'union', text: '' })
    const branches = []
    for (const option of options) {
      const value = option.properties[discriminator].const
      const stem = pascal(value)
      const branch = stem.endsWith(suffix) ? stem : `${stem}${suffix}`
      this.emitRecord(branch, option, {
        base: name,
        discriminator,
        description: `<c>${xml(value)}</c> — one branch of <see cref="${name}"/>.`,
      })
      branches.push({ value, branch })
    }
    this.unions.push({ name, discriminator, branches })
    this.types.set(name, {
      kind: 'union',
      text: `${doc(xml(def.description))}public abstract record ${name}\n{\n    /// <summary>The value of the discriminator (<c>${xml(discriminator)}</c>) for this branch. Not a JSON property: the branch's own <c>${xml(discriminator)}</c> is.</summary>\n    [JsonIgnore]\n    public abstract string Discriminator { get; }\n}\n`,
    })
  }

  /** A property's C# type, emitting whatever anonymous type it needs. Returns { type, valueType }. */
  typeOf(node, owner, property) {
    if (node.$ref) {
      const name = this.refName(node)
      const kind = this.defKind(name)
      if (kind === 'primitive' || kind === 'dictionary')
        return this.typeOf(this.defs[name], owner, property)
      return { type: name, valueType: kind === 'enum' }
    }
    if (node.oneOf) this.fail(`${owner}.${property}`, 'an anonymous union — name it in schema.ts')
    if (node.anyOf) {
      if (this.isStringSet(node.anyOf)) {
        const name = `${owner}${pascal(property)}`
        this.emitEnum(name, this.stringSetValues(node.anyOf))
        return { type: name, valueType: true }
      }
      this.fail(`${owner}.${property}`, 'an anyOf that is neither nullable nor a string set')
    }
    if (node.enum) {
      const name = `${owner}${pascal(property)}`
      this.emitEnum(name, node.enum)
      return { type: name, valueType: true }
    }
    const type = Array.isArray(node.type) ? node.type.find(t => t !== 'null') : node.type
    switch (type) {
      case 'string':
        return { type: 'string', valueType: false }
      case 'integer':
        return { type: 'long', valueType: true }
      case 'number':
        return { type: Number.isInteger(node.const) ? 'long' : 'double', valueType: true }
      case 'boolean':
        return { type: 'bool', valueType: true }
      case 'array': {
        const item = this.typeOf(node.items, owner, singular(property))
        return { type: `IReadOnlyList<${item.type}>`, valueType: false }
      }
      case 'object': {
        if (node.properties) {
          const name = `${owner}${pascal(property)}`
          this.emitRecord(name, node, {
            description: `The <c>${xml(property)}</c> block of <see cref="${owner}"/>.`,
          })
          return { type: name, valueType: false }
        }
        const values = node.additionalProperties
        if (values === undefined || Object.keys(values).length === 0)
          return { type: 'JsonObject', valueType: false }
        const value = this.typeOf(values, owner, `${property}Value`)
        return { type: `Dictionary<string, ${value.type}>`, valueType: false }
      }
      case undefined:
        if (Object.keys(node).filter(key => key !== 'description').length === 0)
          return { type: 'JsonNode', valueType: false, unknown: true }
        break
      default:
    }
    this.fail(`${owner}.${property}`, `unsupported schema ${JSON.stringify(node).slice(0, 120)}`)
  }

  isNullable(node) {
    if (Array.isArray(node.type)) return node.type.includes('null')
    if (node.anyOf) return node.anyOf.some(option => option.type === 'null')
    return false
  }

  /** The node with its `null` option peeled off. */
  stripNull(node) {
    if (Array.isArray(node.type)) return { ...node, type: node.type.find(t => t !== 'null') }
    if (node.anyOf) {
      const rest = node.anyOf.filter(option => option.type !== 'null')
      if (rest.length === 1) return rest[0]
      return { ...node, anyOf: rest }
    }
    return node
  }

  literal(value, type) {
    if (value === null) return 'null'
    if (typeof value === 'string') {
      if (type !== 'string') return `${type}.${enumMember(value)}`
      return csString(value)
    }
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (Array.isArray(value)) {
      if (value.length !== 0) this.fail(type, 'only an empty array default is supported')
      return '[]'
    }
    if (typeof value === 'object') {
      if (Object.keys(value).length !== 0)
        this.fail(type, 'only an empty object default is supported')
      return 'new()'
    }
    this.fail(type, `unsupported default ${JSON.stringify(value)}`)
  }

  emitRecord(name, node, { base, discriminator, description } = {}) {
    if (this.types.has(name))
      this.fail(name, 'emitted twice — two anonymous objects resolved to one name')
    this.types.set(name, { kind: 'record', text: '' })
    const required = new Set(node.required ?? [])
    const members = []
    let order = 0
    for (const [key, property] of Object.entries(node.properties ?? {})) {
      const nullable = this.isNullable(property)
      const isRequired = required.has(key)
      if (nullable && !isRequired)
        this.fail(
          `${name}.${key}`,
          'optional and nullable — the C# could not tell absent from null; pick one',
        )
      const resolved = this.typeOf(this.stripNull(property), name, key)
      const csName = pascal(key)
      const attributes = [`[JsonPropertyName(${csString(key)})]`, `[JsonPropertyOrder(${order++})]`]
      let declaration
      if (property.const !== undefined) {
        const value = this.literal(property.const, resolved.type)
        declaration =
          key === discriminator
            ? `public string ${csName} => TypeName;`
            : `public ${resolved.type} ${csName} => ${value};`
      } else if (property.default !== undefined) {
        const optional = nullable || resolved.unknown ? '?' : ''
        declaration = `public ${resolved.type}${optional} ${csName} { get; init; } = ${this.literal(property.default, resolved.type)};`
      } else if (isRequired && !nullable && !resolved.unknown) {
        declaration = `public required ${resolved.type} ${csName} { get; init; }`
      } else if (isRequired) {
        declaration = `public ${resolved.type}? ${csName} { get; init; }`
      } else {
        attributes.push('[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]')
        declaration = `public ${resolved.type}? ${csName} { get; init; }`
      }
      members.push(`    ${[...attributes, declaration].join('\n    ')}`)
    }
    const head = []
    if (discriminator) {
      head.push(`    /// <summary>The discriminator this branch carries.</summary>`)
      head.push(
        `    public const string TypeName = ${csString(node.properties[discriminator].const)};`,
      )
      head.push('')
      head.push('    [JsonIgnore]')
      head.push('    public override string Discriminator => TypeName;')
      head.push('')
    }
    const inherits = base ? ` : ${base}` : ''
    this.types.set(name, {
      kind: 'record',
      text: `${doc(description)}public sealed record ${name}${inherits}\n{\n${head.join('\n')}${head.length ? '\n' : ''}${members.join('\n\n')}\n}\n`,
    })
  }

  converters() {
    return this.unions
      .map(({ name, discriminator, branches }) => {
        const cases = branches.map(
          ({ value, branch }) => `            ${csString(value)} => typeof(${branch}),`,
        )
        return `internal sealed class ${name}Converter : DiscriminatedUnionConverter<${name}>
{
    public ${name}Converter() : base(${csString(discriminator)}) { }

    protected override Type? Resolve(string discriminator) =>
        discriminator switch
        {
${cases.join('\n')}
            _ => null,
        };
}
`
      })
      .join('\n')
  }

  constants() {
    const entries = Object.entries(this.document['x-constants']).map(([key, value]) => {
      const name = pascal(key.toLowerCase())
      if (typeof value === 'string') return `    public const string ${name} = ${csString(value)};`
      if (Number.isInteger(value) && Math.abs(value) < 2 ** 31)
        return `    public const int ${name} = ${value};`
      if (Number.isInteger(value)) return `    public const long ${name} = ${value}L;`
      return `    public const double ${name} = ${value};`
    })
    return `/// <summary>The numbers both ends agree on (<c>packages/protocol/src/constants.ts</c>).</summary>
public static class ProtocolConstants
{
${entries.join('\n')}
}
`
  }

  file() {
    const source = SCHEMA
    const version = this.document['x-protocol-version']
    const sections = [
      HEADER(source, version),
      this.constants(),
      ...[...this.types.values()].map(entry => entry.text),
      RUNTIME(this.unions.map(union => union.name)),
      this.converters(),
    ]
    return sections.join('\n')
  }
}

const doc = description => (description ? `/// <summary>${description}</summary>\n` : '')

const HEADER = (source, version) => `// <auto-generated>
//   Generated by scripts/protocol-codegen.mjs from ${source} (protocol v${version}),
//   which is itself exported from packages/protocol/src by scripts/protocol-schema.mjs.
//   Do not edit: change the Zod schema and run \`pnpm build\`; \`pnpm lint\` fails when
//   this file is stale. Every shape here is proven against the fixtures under
//   packages/protocol/fixtures and packages/match-api/fixtures/recorded by EZPug.Sdk.Tests.
// </auto-generated>
#nullable enable

using System.Globalization;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace ${NAMESPACE};
`

const RUNTIME = unions => `/// <summary>
/// How the protocol reads and writes JSON: the options every frame is (de)serialized
/// with, so the bytes match what the TypeScript side writes — relaxed escaping (non-ASCII
/// stays as it is), enums by their wire names, doubles printed the way JavaScript prints
/// them, unions dispatched on their discriminator.
/// </summary>
public static class ProtocolJson
{
    /// <summary>A fresh options object; copy it to add <c>WriteIndented</c> or the like.</summary>
    public static JsonSerializerOptions CreateOptions()
    {
        var options = new JsonSerializerOptions(JsonSerializerDefaults.General)
        {
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
            DefaultIgnoreCondition = JsonIgnoreCondition.Never,
            NumberHandling = JsonNumberHandling.Strict,
            ReadCommentHandling = JsonCommentHandling.Disallow,
            AllowTrailingCommas = false,
        };
        options.Converters.Add(new JsonStringEnumConverter());
        options.Converters.Add(new JavaScriptNumberConverter());
${unions.map(name => `        options.Converters.Add(new ${name}Converter());`).join('\n')}
        return options;
    }

    /// <summary>The shared, read-only options. Serializing with anything else is a bug.</summary>
    public static JsonSerializerOptions Options { get; } = CreateOptions();

    /// <summary>One frame as one line of JSON — what goes on the wire.</summary>
    public static string Serialize<T>(T value) => JsonSerializer.Serialize(value, Options);

    /// <summary>One frame off the wire. Throws <see cref="JsonException"/> on anything that is not one.</summary>
    public static T Deserialize<T>(string json) =>
        JsonSerializer.Deserialize<T>(json, Options)
        ?? throw new JsonException($"{typeof(T).Name}: JSON null where a value was expected");
}

/// <summary>
/// Reads a discriminated union by peeking at its discriminator wherever the object puts
/// it, and writes the runtime type as itself. Registered on <see cref="ProtocolJson.Options"/>
/// rather than by attribute, so the branch records never inherit it and recurse.
/// </summary>
internal abstract class DiscriminatedUnionConverter<TBase> : JsonConverter<TBase>
    where TBase : class
{
    private readonly string _discriminator;

    protected DiscriminatedUnionConverter(string discriminator)
    {
        _discriminator = discriminator;
    }

    /// <summary>The branch type for a discriminator value, or null for one this build does not know.</summary>
    protected abstract Type? Resolve(string discriminator);

    public sealed override bool CanConvert(Type typeToConvert) => typeToConvert == typeof(TBase);

    public sealed override TBase? Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null)
        {
            return null;
        }

        using var document = JsonDocument.ParseValue(ref reader);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object
            || !root.TryGetProperty(_discriminator, out var value)
            || value.ValueKind != JsonValueKind.String)
        {
            throw new JsonException($"{typeof(TBase).Name}: expected an object with a string \`{_discriminator}\`");
        }

        var kind = value.GetString()!;
        var type = Resolve(kind) ?? throw new JsonException($"{typeof(TBase).Name}: unknown {_discriminator} \`{kind}\`");
        return (TBase?)root.Deserialize(type, options);
    }

    public sealed override void Write(Utf8JsonWriter writer, TBase value, JsonSerializerOptions options) =>
        JsonSerializer.Serialize(writer, value, value.GetType(), options);
}

/// <summary>
/// Writes a double exactly as JavaScript's <c>Number.prototype.toString</c> would
/// (<c>0.000001</c>, <c>1e-7</c>, <c>1180</c>, <c>1e+21</c>), so a frame the plugin writes
/// is byte-identical to the same frame written by <c>JSON.stringify</c>. Reads are plain.
/// </summary>
public sealed class JavaScriptNumberConverter : JsonConverter<double>
{
    public override double Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.GetDouble();

    public override void Write(Utf8JsonWriter writer, double value, JsonSerializerOptions options) =>
        writer.WriteRawValue(Format(value), skipInputValidation: true);

    /// <summary>ECMAScript's Number::toString for finite doubles, from .NET's shortest round-trip digits.</summary>
    public static string Format(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value))
        {
            throw new JsonException("JSON has no NaN or Infinity");
        }

        if (value == 0)
        {
            return "0";
        }

        var text = value.ToString("R", CultureInfo.InvariantCulture);
        var negative = text.StartsWith('-');
        if (negative)
        {
            text = text[1..];
        }

        var exponentAt = text.IndexOfAny(['E', 'e']);
        var exponent = 0;
        var mantissa = text;
        if (exponentAt >= 0)
        {
            exponent = int.Parse(text[(exponentAt + 1)..], CultureInfo.InvariantCulture);
            mantissa = text[..exponentAt];
        }

        var dot = mantissa.IndexOf('.');
        var integerLength = dot < 0 ? mantissa.Length : dot;
        var digits = mantissa.Replace(".", "");
        var leadingZeros = 0;
        while (leadingZeros < digits.Length - 1 && digits[leadingZeros] == '0')
        {
            leadingZeros++;
        }

        digits = digits[leadingZeros..].TrimEnd('0');
        if (digits.Length == 0)
        {
            digits = "0";
        }

        // value = 0.d1d2…dk × 10^n, in the spec's terms.
        var n = integerLength - leadingZeros + exponent;
        var k = digits.Length;
        string result;
        if (k <= n && n <= 21)
        {
            result = digits + new string('0', n - k);
        }
        else if (n > 0 && n <= 21)
        {
            result = digits[..n] + "." + digits[n..];
        }
        else if (n > -6 && n <= 0)
        {
            result = "0." + new string('0', -n) + digits;
        }
        else
        {
            var e = n - 1;
            var sign = e < 0 ? "-" : "+";
            var magnitude = Math.Abs(e).ToString(CultureInfo.InvariantCulture);
            result = k == 1
                ? digits + "e" + sign + magnitude
                : digits[..1] + "." + digits[1..] + "e" + sign + magnitude;
        }

        return negative ? "-" + result : result;
    }
}
`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const check = process.argv.includes('--check')
const document = JSON.parse(readFileSync(join(repo, SCHEMA), 'utf8'))
const generated = new Generator(document).file()
const target = join(repo, OUTPUT)

if (check) {
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // missing counts as stale
  }
  if (current !== generated) {
    console.error(`protocol-codegen: ${OUTPUT} is stale — run \`pnpm build\` and commit the result`)
    process.exit(1)
  }
  console.log(`protocol-codegen: ${OUTPUT} is current`)
} else {
  mkdirSync(dirname(target), { recursive: true })
  let current = ''
  try {
    current = readFileSync(target, 'utf8')
  } catch {
    // first generation
  }
  if (current === generated) {
    console.log(`protocol-codegen: ${OUTPUT} unchanged`)
  } else {
    writeFileSync(target, generated)
    console.log(`protocol-codegen: wrote ${OUTPUT}`)
  }
}
