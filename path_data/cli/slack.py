from json import dumps
from os import environ
from urllib.request import Request, urlopen

from click import argument, option
from utz import err

from path_data.cli.base import path_data

SLACK_API_URL = 'https://slack.com/api/chat.postMessage'


def post_message(
    text: str,
    channel: str,
    token: str,
    username: str | None = None,
    icon_emoji: str | None = None,
):
    """Post a message to Slack via the Bot API."""
    payload = dict(channel=channel, text=text)
    if username:
        payload['username'] = username
    if icon_emoji:
        payload['icon_emoji'] = icon_emoji

    data = dumps(payload).encode()
    req = Request(
        SLACK_API_URL,
        data=data,
        headers={
            'Authorization': f'Bearer {token}',
            'Content-Type': 'application/json',
        },
    )
    with urlopen(req) as resp:
        body = resp.read().decode()

    from json import loads
    result = loads(body)
    if not result.get('ok'):
        raise RuntimeError(f"Slack API error: {result.get('error', body)}")
    return result


@path_data.command('slack')
@option('-c', '--channel', envvar='SLACK_CHANNEL_ID', required=True, help='Slack channel ID')
@option('-e', '--icon-emoji', default=':train:', help='Bot icon emoji')
@option('-t', '--token', envvar='SLACK_BOT_TOKEN', required=True, help='Slack bot token')
@option('-u', '--username', default='PATH Data', help='Bot display name')
@argument('message')
def slack(channel: str, icon_emoji: str, token: str, username: str, message: str):
    """Post a notification to Slack."""
    result = post_message(
        text=message,
        channel=channel,
        token=token,
        username=username,
        icon_emoji=icon_emoji,
    )
    err(f"Posted to #{channel}: ts={result.get('ts')}")
