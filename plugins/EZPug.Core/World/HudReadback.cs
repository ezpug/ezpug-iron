using System.Text;

namespace EZPug.Core;

/// <summary>Whether a panel has a class, as one state of a layout holds it: the engine's three answers.</summary>
public enum HudClassStatus
{
    /// <summary>The state was told about the class once and says nothing now.</summary>
    Undefined,
    DoesNotHave,
    Has,
}

/// <summary>One class on one panel, by the entity's own indexes into its names.</summary>
public sealed record HudClassReading(int Panel, int Class, HudClassStatus Status);

/// <summary>One <c>{s:variable}</c> on one panel, by the entity's own indexes into its names.</summary>
public sealed record HudStringReading(int Panel, int Variable, string Value, bool IsSet);

/// <summary>What one state of a layout holds: everybody's, or one slot's.</summary>
public sealed record HudStateReading(
    int Slot,
    bool TakesInput,
    IReadOnlyList<HudClassReading> Classes,
    IReadOnlyList<HudStringReading> Strings)
{
    /// <summary>Nothing was ever said to this state.</summary>
    public bool Empty => !TakesInput && Classes.Count == 0 && Strings.Count == 0;
}

/// <summary>
/// One <c>custom_hud_layout</c> of ours, <b>read back off the entity</b> (PRD-07 T9):
/// what the server networks to every client, not what the SDK's <c>Hud</c> believes it
/// asked for. The names are the entity's three tables, and each state indexes into them.
/// </summary>
public sealed record HudLayoutReading(
    uint Entity,
    string Layout,
    bool Observable,
    IReadOnlyList<string> Panels,
    IReadOnlyList<string> Classes,
    IReadOnlyList<string> Variables,
    HudStateReading Everybody,
    IReadOnlyList<HudStateReading> Slots);

/// <summary>
/// The lines <c>ezpug_status</c> says about the layouts in the world, on a server that
/// can draw a HUD. One line per layout, one per panel somebody was told something
/// about, and one that counts the slots holding nothing, so "no bot was told anything"
/// is a line and not an absence. Nothing here is acted on: it is an operator's look,
/// and the CS2 lane's (<c>docs/hud.md</c>, "What the server holds").
/// </summary>
public static class HudReadback
{
    public static IReadOnlyList<string> Render(IReadOnlyList<HudLayoutReading> layouts)
    {
        if (layouts.Count == 0)
        {
            return ["hud: no layout of ours is in the world"];
        }

        var lines = new List<string>();
        foreach (var layout in layouts)
        {
            lines.Add(
                $"hud: layout {layout.Layout} is entity {layout.Entity}{(layout.Observable ? ", observable" : "")}, {layout.Slots.Count} slot(s); " +
                $"panels [{string.Join(", ", layout.Panels)}], classes [{string.Join(", ", layout.Classes)}], strings [{string.Join(", ", layout.Variables)}]");
            State(lines, layout, "everybody", layout.Everybody);
            foreach (var slot in layout.Slots.Where(slot => !slot.Empty))
            {
                State(lines, layout, $"slot {slot.Slot}", slot);
            }

            lines.Add($"hud:   {layout.Slots.Count(slot => slot.Empty)} of {layout.Slots.Count} slot(s) hold nothing");
        }

        return lines;
    }

    private static void State(List<string> lines, HudLayoutReading layout, string who, HudStateReading state)
    {
        if (state.TakesInput)
        {
            lines.Add($"hud:   {who} TAKES THE MOUSE, which nothing of ours ever asks for");
        }

        var panels = state.Classes.Select(entry => entry.Panel).Concat(state.Strings.Select(entry => entry.Panel)).Distinct().Order();
        foreach (var panel in panels)
        {
            var said = new StringBuilder();
            foreach (var entry in state.Classes.Where(entry => entry.Panel == panel))
            {
                var sign = entry.Status switch
                {
                    HudClassStatus.Has => '+',
                    HudClassStatus.DoesNotHave => '-',
                    _ => '?',
                };
                said.Append(' ').Append(sign).Append(Name(layout.Classes, entry.Class));
            }

            foreach (var entry in state.Strings.Where(entry => entry.Panel == panel))
            {
                said.Append(" {s:").Append(Name(layout.Variables, entry.Variable)).Append('}');
                said.Append(entry.IsSet ? $"=\"{entry.Value}\"" : " unset");
            }

            lines.Add($"hud:   {who}, {Name(layout.Panels, panel)}:{said}");
        }
    }

    /// <summary>A name by its index, or the index itself where the table does not reach: a reading is never worth an exception.</summary>
    private static string Name(IReadOnlyList<string> names, int index) =>
        index >= 0 && index < names.Count ? names[index] : $"#{index}";
}
