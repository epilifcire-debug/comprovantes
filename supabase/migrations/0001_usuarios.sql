-- Usuários do app Folha → Drive.
-- Login por usuário OU e-mail + senha. E-mail é opcional e não exige confirmação.
-- O acesso é feito só pelo servidor (chave service_role), por isso o RLS fica ativo sem políticas.

create table if not exists public.usuarios (
  id          uuid primary key default gen_random_uuid(),
  username    text not null unique
              check (username ~ '^[a-z0-9._-]{3,30}$'),
  email       text unique
              check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  senha_hash  text not null,
  papel       text not null default 'membro'
              check (papel in ('admin_master', 'membro')),
  ativo       boolean not null default true,
  criado_em   timestamptz not null default now()
);

-- Só pode existir um administrador master (você).
create unique index if not exists usuarios_um_admin_master
  on public.usuarios (papel) where papel = 'admin_master';

alter table public.usuarios enable row level security;
-- Sem políticas de propósito: nenhum acesso pela chave anon/publishable.
