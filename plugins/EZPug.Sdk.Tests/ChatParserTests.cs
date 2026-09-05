using Xunit;

namespace EZPug.Sdk.Tests;

/// <summary>The same cases the package's <c>parseServerChatLine</c> test pins; the split must agree in both languages.</summary>
public class ChatParserTests
{
    [Theory]
    [InlineData("!tech", "tech", null)]
    [InlineData(".GG now", "gg", "now")]
    [InlineData("/rehost  please   now ", "rehost", "please now")]
    [InlineData("!powerup haste", "powerup", "haste")]
    public void APrefixedBareWordIsACommand(string raw, string command, string? args)
    {
        var parsed = Assert.IsType<ChatParser.Parsed.Command>(ChatParser.Parse(raw));
        Assert.Equal(command, parsed.Name);
        Assert.Equal(args, parsed.Args);
    }

    [Theory]
    [InlineData("gg", "gg")]
    [InlineData(".", ".")]
    [InlineData("!!!", "!!!")]
    [InlineData(".42px?", ".42px?")]
    [InlineData("  nice shot  ", "nice shot")]
    public void EverythingElseIsConversation(string raw, string text)
    {
        var parsed = Assert.IsType<ChatParser.Parsed.Message>(ChatParser.Parse(raw));
        Assert.Equal(text, parsed.Text);
    }
}
