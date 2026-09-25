"""Taiga pagina los listados en 30 items; los list_* que no propagan `page`
a la query deben pedir la coleccion completa con x-disable-pagination."""
import httpx
import pytest

from taiga_client import TaigaClient


def _client(monkeypatch, capturadas):
    monkeypatch.setenv("TAIGA_BASE_URL", "https://api.taiga.io")
    monkeypatch.setenv("TAIGA_USERNAME", "u")
    monkeypatch.setenv("TAIGA_PASSWORD", "p")

    async def handler(request: httpx.Request) -> httpx.Response:
        capturadas.append(request)
        return httpx.Response(200, json=[])

    client = TaigaClient()
    client._client = httpx.AsyncClient(
        base_url="https://api.taiga.io/api/v1/",
        transport=httpx.MockTransport(handler),
    )
    return client


@pytest.mark.anyio("asyncio")
@pytest.mark.parametrize(
    "llamada",
    [
        lambda c: c.list_epics(1),
        lambda c: c.list_users(project_id=1),
        lambda c: c.list_user_stories(1),
    ],
)
async def test_listados_sin_page_piden_todo(monkeypatch, llamada):
    capturadas: list[httpx.Request] = []
    await llamada(_client(monkeypatch, capturadas))
    assert capturadas[-1].headers.get("x-disable-pagination") == "True"


@pytest.mark.anyio("asyncio")
async def test_user_stories_con_page_respeta_la_paginacion(monkeypatch):
    capturadas: list[httpx.Request] = []
    await _client(monkeypatch, capturadas).list_user_stories(1, page=2, page_size=10)
    pedido = capturadas[-1]
    assert "x-disable-pagination" not in pedido.headers
    assert "page=2" in str(pedido.url)
