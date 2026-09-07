using System.Text.Json;
using System.Text.Json.Nodes;

namespace EZPug.Sdk;

/// <summary>
/// The corner of JSON Schema (draft 2020-12) a manifest's <c>commands[].args</c> uses,
/// checked before a mode sees the tap: <c>type</c> (object, string, number, integer,
/// boolean, array, null), <c>properties</c>, <c>required</c>, <c>additionalProperties</c>,
/// <c>enum</c>, <c>const</c>, <c>minimum</c>/<c>maximum</c>, <c>minLength</c>/<c>maxLength</c>,
/// <c>items</c>, <c>minItems</c>/<c>maxItems</c>. The widget validates against the same
/// document before it sends; this is the plugin's half of "one document, two checks".
/// A keyword outside this set is ignored, never refused — a manifest is validated at
/// parse time by the package, so what arrives is a schema the author meant.
/// </summary>
public static class ArgsValidator
{
    /// <summary>
    /// <b>The chat form of a tap.</b> A phone sends <c>{ "kind": "radar_peek" }</c>;
    /// somebody typing <c>!powerup radar_peek</c> means the same thing, and this is where
    /// the one becomes the other: the words after the verb are the value of the schema's
    /// <b>first declared property</b>, whole, converted to that property's declared scalar
    /// type. One argument, however many words — so <c>!say hello world</c> is one string
    /// and not two — and a verb whose args need more than one field simply cannot be typed,
    /// which is fine: the widget is that verb's door and the SDK refuses what does not fit
    /// either way (<see cref="Validate"/>, in the player's language).
    ///
    /// <c>null</c> when there is nothing to say: no schema, no properties, or no words.
    /// </summary>
    public static JsonObject? FromChat(JsonObject? schema, string? rest)
    {
        var text = rest?.Trim();
        if (schema is null || string.IsNullOrEmpty(text) || schema["properties"] is not JsonObject properties)
        {
            return null;
        }

        var first = properties.FirstOrDefault();
        if (first.Key is null)
        {
            return null;
        }

        return new JsonObject { [first.Key] = Scalar(first.Value as JsonObject, text) };
    }

    /// <summary>The typed word: a number where the property says number, a boolean where it says boolean, the text otherwise. A word that does not parse stays text and is refused by <see cref="Validate"/> with the property's own message.</summary>
    private static JsonNode Scalar(JsonObject? schema, string text) =>
        schema?["type"]?.GetValue<string>() switch
        {
            "integer" when long.TryParse(text, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var whole) => JsonValue.Create(whole),
            "number" when double.TryParse(text, System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var real) => JsonValue.Create(real),
            "boolean" when bool.TryParse(text, out var flag) => JsonValue.Create(flag),
            _ => JsonValue.Create(text),
        };

    /// <summary>The first problem found, or <c>null</c> when <paramref name="args"/> fits.</summary>
    public static string? Validate(JsonObject? schema, JsonObject? args)
    {
        if (schema is null)
        {
            // A verb without an args schema takes none; an empty object is "none" too.
            return args is null || args.Count == 0 ? null : "this command takes no arguments";
        }

        return Check(schema, args ?? new JsonObject(), "args");
    }

    private static string? Check(JsonObject schema, JsonNode? value, string path)
    {
        if (schema["const"] is { } constant && !JsonNode.DeepEquals(constant, value))
        {
            return $"{path} must be {constant.ToJsonString()}";
        }

        if (schema["enum"] is JsonArray choices && !choices.Any(choice => JsonNode.DeepEquals(choice, value)))
        {
            return $"{path} must be one of {choices.ToJsonString()}";
        }

        var type = schema["type"]?.GetValue<string>();
        if (type is not null)
        {
            var problem = CheckType(type, value, path);
            if (problem is not null)
            {
                return problem;
            }
        }

        switch (value)
        {
            case JsonObject obj:
                return CheckObject(schema, obj, path);
            case JsonArray array:
                return CheckArray(schema, array, path);
            case JsonValue scalar:
                return CheckScalar(schema, scalar, path);
            default:
                return null;
        }
    }

    private static string? CheckType(string type, JsonNode? value, string path)
    {
        var fits = type switch
        {
            "object" => value is JsonObject,
            "array" => value is JsonArray,
            "null" => value is null,
            "string" => value is JsonValue v && v.TryGetValue<string>(out _),
            "boolean" => value is JsonValue v && v.TryGetValue<bool>(out _),
            "number" => IsNumber(value, integer: false),
            "integer" => IsNumber(value, integer: true),
            _ => true,
        };
        return fits ? null : $"{path} must be {(type == "integer" ? "an integer" : $"a {type}")}";
    }

    private static bool IsNumber(JsonNode? value, bool integer)
    {
        if (value is not JsonValue scalar || !scalar.TryGetValue<JsonElement>(out var element) || element.ValueKind != JsonValueKind.Number)
        {
            return value is JsonValue direct && (direct.TryGetValue<double>(out var d) && (!integer || Math.Floor(d) == d));
        }

        return !integer || element.TryGetInt64(out _) || (element.TryGetDouble(out var asDouble) && Math.Floor(asDouble) == asDouble);
    }

    private static string? CheckObject(JsonObject schema, JsonObject value, string path)
    {
        var properties = schema["properties"] as JsonObject;
        if (schema["required"] is JsonArray required)
        {
            foreach (var name in required.Select(node => node?.GetValue<string>()).Where(name => name is not null))
            {
                if (!value.ContainsKey(name!))
                {
                    return $"{path}.{name} is required";
                }
            }
        }

        foreach (var (name, child) in value)
        {
            if (properties?[name] is JsonObject childSchema)
            {
                var problem = Check(childSchema, child, $"{path}.{name}");
                if (problem is not null)
                {
                    return problem;
                }
            }
            else if (schema["additionalProperties"] is JsonValue allowed && allowed.TryGetValue<bool>(out var ok) && !ok)
            {
                return $"{path}.{name} is not allowed";
            }
        }

        return null;
    }

    private static string? CheckArray(JsonObject schema, JsonArray value, string path)
    {
        if (schema["minItems"] is JsonValue min && min.TryGetValue<int>(out var minItems) && value.Count < minItems)
        {
            return $"{path} needs at least {minItems} items";
        }

        if (schema["maxItems"] is JsonValue max && max.TryGetValue<int>(out var maxItems) && value.Count > maxItems)
        {
            return $"{path} allows at most {maxItems} items";
        }

        if (schema["items"] is JsonObject items)
        {
            for (var i = 0; i < value.Count; i++)
            {
                var problem = Check(items, value[i], $"{path}[{i}]");
                if (problem is not null)
                {
                    return problem;
                }
            }
        }

        return null;
    }

    private static string? CheckScalar(JsonObject schema, JsonValue value, string path)
    {
        if (value.TryGetValue<string>(out var text))
        {
            if (schema["minLength"] is JsonValue min && min.TryGetValue<int>(out var minLength) && text.Length < minLength)
            {
                return $"{path} must be at least {minLength} characters";
            }

            if (schema["maxLength"] is JsonValue max && max.TryGetValue<int>(out var maxLength) && text.Length > maxLength)
            {
                return $"{path} must be at most {maxLength} characters";
            }

            return null;
        }

        if (value.TryGetValue<double>(out var number))
        {
            if (schema["minimum"] is JsonValue min && min.TryGetValue<double>(out var minimum) && number < minimum)
            {
                return $"{path} must be at least {Format(minimum)}";
            }

            if (schema["maximum"] is JsonValue max && max.TryGetValue<double>(out var maximum) && number > maximum)
            {
                return $"{path} must be at most {Format(maximum)}";
            }
        }

        return null;
    }

    private static string Format(double number) => number.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
